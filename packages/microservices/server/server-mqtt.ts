import { isUndefined } from '@nestjs/common/utils/shared.utils';
import { Observable } from 'rxjs';
import {
  CONNECT_EVENT,
  ERROR_EVENT,
  MESSAGE_EVENT,
  MQTT_DEFAULT_URL,
  NO_MESSAGE_HANDLER,
  MQTT_SEPARATOR,
  MQTT_WILDCARD_ALL,
  MQTT_WILDCARD_SINGLE,
} from '../constants';
import { MqttClient } from '../external/mqtt-client.interface';
import {
  CustomTransportStrategy,
  IncomingRequest,
  MessageHandler,
  PacketId,
  ReadPacket,
} from '../interfaces';
import { MqttOptions } from '../interfaces/microservice-configuration.interface';
import { Server } from './server';

let mqttPackage: any = {};

export class ServerMqtt extends Server implements CustomTransportStrategy {
  private readonly url: string;
  private mqttClient: MqttClient;

  constructor(private readonly options: MqttOptions['options']) {
    super();
    this.url = this.getOptionsProp(options, 'url') || MQTT_DEFAULT_URL;

    mqttPackage = this.loadPackage('mqtt', ServerMqtt.name, () =>
      require('mqtt'),
    );

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  public async listen(callback: () => void) {
    this.mqttClient = this.createMqttClient();
    this.start(callback);
  }

  public start(callback?: () => void) {
    this.handleError(this.mqttClient);
    this.bindEvents(this.mqttClient);

    this.mqttClient.on(CONNECT_EVENT, callback);
  }

  public bindEvents(mqttClient: MqttClient) {
    mqttClient.on(MESSAGE_EVENT, this.getMessageHandler(mqttClient).bind(this));
    const registeredPatterns = [...this.messageHandlers.keys()];
    registeredPatterns.forEach(pattern => {
      const { isEventHandler } = this.messageHandlers.get(pattern);
      mqttClient.subscribe(
        isEventHandler ? pattern : this.getAckQueueName(pattern),
      );
    });
  }

  public close() {
    this.mqttClient && this.mqttClient.end();
  }

  public createMqttClient(): MqttClient {
    return mqttPackage.connect(this.url, this.options as MqttOptions);
  }

  public matchMqttPattern(pattern, topic) {
    const patternSegments = pattern.split(MQTT_SEPARATOR);
    const topicSegments = topic.split(MQTT_SEPARATOR);
    const patternLength = patternSegments.length;
    const topicLength = topicSegments.length;
    const lastIndex = patternLength - 1;

    for (let i = 0; i < patternLength; i++) {
      const currentPattern = patternSegments[i];
      const patternChar = currentPattern[0];
      const currentTopic = topicSegments[i];

      if (!currentTopic && !currentPattern) continue;

      if (!currentTopic && currentPattern !== MQTT_WILDCARD_ALL) return false;

      if (patternChar === MQTT_WILDCARD_ALL) return i === lastIndex;

      if (
        patternChar !== MQTT_WILDCARD_SINGLE &&
        currentPattern !== currentTopic
      )
        return false;
    }

    return patternLength === topicLength;
  }

  public getHandlerByPattern(pattern: string): MessageHandler | null {
    const route = this.getRouteFromPattern(pattern);

    if (this.messageHandlers.has(route)) {
      return this.messageHandlers.get(route);
    }

    for (const [key, value] of this.messageHandlers) {
      if (key.indexOf(MQTT_WILDCARD_SINGLE) === -1 && key.indexOf(MQTT_WILDCARD_ALL) === -1) {
        continue;
      }

      if (this.matchMqttPattern(key, route)) {
        return value;
      }
    }

    return null;
  }

  public getMessageHandler(pub: MqttClient): Function {
    return async (channel: string, buffer: Buffer) =>
      this.handleMessage(channel, buffer, pub);
  }

  public async handleMessage(
    channel: string,
    buffer: Buffer,
    pub: MqttClient,
  ): Promise<any> {
    const rawPacket = this.parseMessage(buffer.toString());
    const packet = this.deserializer.deserialize(rawPacket, { channel });
    if (isUndefined((packet as IncomingRequest).id)) {
      return this.handleEvent(channel, packet);
    }
    const pattern = channel.replace(/_ack$/, '');
    const publish = this.getPublisher(
      pub,
      pattern,
      (packet as IncomingRequest).id,
    );
    const handler = this.getHandlerByPattern(pattern);

    if (!handler) {
      const status = 'error';
      const noHandlerPacket = {
        id: (packet as IncomingRequest).id,
        status,
        err: NO_MESSAGE_HANDLER,
      };
      return publish(noHandlerPacket);
    }
    const response$ = this.transformToObservable(
      await handler(packet.data),
    ) as Observable<any>;
    response$ && this.send(response$, publish);
  }

  public getPublisher(client: MqttClient, pattern: any, id: string): any {
    return (response: any) => {
      Object.assign(response, { id });
      const outgoingResponse = this.serializer.serialize(response);

      return client.publish(
        this.getResQueueName(pattern),
        JSON.stringify(outgoingResponse),
      );
    };
  }

  public parseMessage(content: any): ReadPacket & PacketId {
    try {
      return JSON.parse(content);
    } catch (e) {
      return content;
    }
  }

  public getAckQueueName(pattern: string): string {
    return `${pattern}_ack`;
  }

  public getResQueueName(pattern: string): string {
    return `${pattern}_res`;
  }

  public handleError(stream: any) {
    stream.on(ERROR_EVENT, (err: any) => this.logger.error(err));
  }
}
