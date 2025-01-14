'use strict';

// ============================================================================
// Subpump
// It controls Twitch PubSub.
// ============================================================================

import Module from 'utilities/module';
import { FFZEvent } from 'utilities/events';

export class PubSubEvent extends FFZEvent {
	constructor(data) {
		super(data);

		this._obj = undefined;
		this._changed = false;
	}

	markChanged() {
		this._changed = true;
	}

	get topic() {
		return this.event.topic;
	}

	get message() {
		if ( this._obj === undefined )
			this._obj = JSON.parse(this.event.message);

		return this._obj;
	}

	set message(val) {
		this._obj = val;
		this._changed = true;
	}
}

export default class Subpump extends Module {

	constructor(...args) {
		super(...args);
		this.instance = null;
	}

	onEnable(tries = 0) {
		const instance = window.__twitch_pubsub_client,
			instances = window.__Twitch__pubsubInstances;

		if ( ! instance && ! instances ) {
			if ( tries > 10 )
				this.log.warn('Unable to find PubSub.');
			else
				new Promise(r => setTimeout(r, 50)).then(() => this.onEnable(tries + 1));

			return;
		}

		if ( instance ) {
			this.instance = instance;
			this.hookClient(instance);
		}

		else if ( instances ) {
			for(const val of Object.values(instances))
				if ( val?._client ) {
					if ( this.instance ) {
						this.log.warn('Multiple PubSub instances detected. Things might act weird.');
						continue;
					}

					this.instance = val;
					this.hookOldClient(val._client);
				}
		}

		if ( ! this.instance )
			this.log.warn('Unable to find a PubSub instance.');
	}

	handleMessage(msg) {
		try {
			if ( msg.type === 'MESSAGE' && msg.data?.topic ) {
				const raw_topic = msg.data.topic,
					idx = raw_topic.indexOf('.'),
					prefix = idx === -1 ? raw_topic : raw_topic.slice(0, idx),
					trail = idx === -1 ? '' : raw_topic.slice(idx + 1);

				const event = new PubSubEvent({
					prefix,
					trail,
					event: msg.data
				});

				this.emit(':pubsub-message', event);
				if ( event.defaultPrevented )
					return true;

				if ( event._changed )
					msg.data.message = JSON.stringify(event._obj);
			}

		} catch(err) {
			this.log.error('Error processing PubSub event.', err);
		}

		return false;
	}

	hookClient(client) {
		const t = this,
			orig_message = client.onMessage;

		this.is_old = false;

		client.connection.removeAllListeners('message');

		client.onMessage = function(e) {
			if ( t.handleMessage(e) )
				return;

			return orig_message.call(this, e);
		}

		client.connection.addListener('message', client.onMessage);

		const orig_on = client.listen,
			orig_off = client.unlisten;

		client.ffz_original_listen = orig_on;
		client.ffz_original_unlisten = orig_off;

		client.listen = function(opts, fn, ...args) {
			const topic = opts.topic,
				has_topic = topic && !! client.topicListeners?._events?.[topic],
				out = orig_on.call(this, opts, fn, ...args);

			if ( topic && ! has_topic )
				t.emit(':add-topic', topic);

			return out;
		}

		client.unlisten = function(topic, fn, ...args) {
			const has_topic = !! client.topicListeners?._events?.[topic],
				out = orig_off.call(this, topic, fn, ...args);

			if ( has_topic && ! client.topicListeners?._events?.[topic] )
				t.emit(':remove-topic', topic);

			return out;
		}
	}

	hookOldClient(client) {
		const t = this,
			orig_message = client._onMessage;

		this.is_old = true;

		client._unbindPrimary(client._primarySocket);

		client._onMessage = function(e) {
			if ( t.handleMessage(e) )
				return;

			return orig_message.call(this, e);
		};

		client._bindPrimary(client._primarySocket);

		const listener = client._listens,
			orig_on = listener.on,
			orig_off = listener.off;

		listener.on = function(topic, fn, ctx) {
			const has_topic = !! listener._events?.[topic],
				out = orig_on.call(this, topic, fn, ctx);

			if ( ! has_topic )
				t.emit(':add-topic', topic)

			return out;
		}

		listener.off = function(topic, fn) {
			const has_topic = !! listener._events?.[topic],
				out = orig_off.call(this, topic, fn);

			if ( has_topic && ! listener._events?.[topic] )
				t.emit(':remove-topic', topic);

			return out;
		}
	}

	inject(topic, message) {
		if ( ! this.instance )
			throw new Error('No PubSub instance available');

		if ( this.is_old ) {
			const listens = this.instance._client?._listens;
			listens._trigger(topic, JSON.stringify(message));
		} else {
			this.instance.simulateMessage(topic, JSON.stringify(message));
		}
	}

	get topics() {
		let events;
		if ( this.is_old )
			events = this.instance?._client?._listens._events;
		else
			events = this.instance?.topicListeners?._events;

		if ( ! events )
			return [];

		return Object.keys(events);
	}

}