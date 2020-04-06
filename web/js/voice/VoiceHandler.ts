import * as log from "tc-shared/log";
import {LogCategory} from "tc-shared/log";
import * as loader from "tc-loader";
import * as aplayer from "../audio/player";
import * as elog from "tc-shared/ui/frames/server_log";
import {BasicCodec} from "../codec/BasicCodec";
import {CodecType} from "../codec/Codec";
import {createErrorModal} from "tc-shared/ui/elements/Modal";
import {CodecWrapperWorker} from "../codec/CodecWrapperWorker";
import {ServerConnection} from "../connection/ServerConnection";
import {voice} from "tc-shared/connection/ConnectionBase";
import {RecorderProfile} from "tc-shared/voice/RecorderProfile";
import {VoiceClientController} from "./VoiceClient";
import {settings} from "tc-shared/settings";
import {CallbackInputConsumer, InputConsumerType, NodeInputConsumer} from "tc-shared/voice/RecorderBase";
import AbstractVoiceConnection = voice.AbstractVoiceConnection;
import VoiceClient = voice.VoiceClient;

export namespace codec {
    class CacheEntry {
        instance: BasicCodec;
        owner: number;

        last_access: number;
    }

    export function codec_supported(type: CodecType) {
        return type == CodecType.OPUS_MUSIC || type == CodecType.OPUS_VOICE;
    }

    export class CodecPool {
        codecIndex: number;
        name: string;
        type: CodecType;

        entries: CacheEntry[] = [];
        maxInstances: number = 2;

        private _supported: boolean = true;

        initialize(cached: number) {
            /* test if we're able to use this codec */
            const dummy_client_id = 0xFFEF;

            this.ownCodec(dummy_client_id, _ => {}).then(codec => {
                log.info(LogCategory.VOICE, tr("Release again! (%o)"), codec);
                this.releaseCodec(dummy_client_id);
            }).catch(error => {
                if(this._supported) {
                    log.warn(LogCategory.VOICE, tr("Disabling codec support for "), this.name);
                    createErrorModal(tr("Could not load codec driver"), tr("Could not load or initialize codec ") + this.name + "<br>" +
                        "Error: <code>" + JSON.stringify(error) + "</code>").open();
                    log.error(LogCategory.VOICE, tr("Failed to initialize the opus codec. Error: %o"), error);
                } else {
                    log.debug(LogCategory.VOICE, tr("Failed to initialize already disabled codec. Error: %o"), error);
                }
                this._supported = false;
            });
        }

        supported() { return this._supported; }

        ownCodec?(clientId: number, callback_encoded: (buffer: Uint8Array) => any, create: boolean = true) : Promise<BasicCodec | undefined> {
            return new Promise<BasicCodec>((resolve, reject) => {
                if(!this._supported) {
                    reject(tr("unsupported codec!"));
                    return;
                }

                let free_slot = 0;
                for(let index = 0; index < this.entries.length; index++) {
                    if(this.entries[index].owner == clientId) {
                        this.entries[index].last_access = Date.now();
                        if(this.entries[index].instance.initialized())
                            resolve(this.entries[index].instance);
                        else {
                            this.entries[index].instance.initialise().then((flag) => {
                                //TODO test success flag
                                this.ownCodec(clientId, callback_encoded, false).then(resolve).catch(reject);
                            }).catch(error => {
                                log.error(LogCategory.VOICE, tr("Could not initialize codec!\nError: %o"), error);
                                reject(typeof(error) === 'string' ? error : tr("Could not initialize codec!"));
                            });
                        }
                        return;
                    } else if(this.entries[index].owner == 0) {
                        free_slot = index;
                    }
                }

                if(!create) {
                    resolve(undefined);
                    return;
                }

                if(free_slot == 0){
                    free_slot = this.entries.length;
                    let entry = new CacheEntry();
                    entry.instance = new CodecWrapperWorker(this.type);
                    this.entries.push(entry);
                }
                this.entries[free_slot].owner = clientId;
                this.entries[free_slot].last_access = new Date().getTime();
                this.entries[free_slot].instance.on_encoded_data = callback_encoded;
                if(this.entries[free_slot].instance.initialized())
                    this.entries[free_slot].instance.reset();
                else {
                    this.ownCodec(clientId, callback_encoded, false).then(resolve).catch(reject);
                    return;
                }
                resolve(this.entries[free_slot].instance);
            });
        }

        releaseCodec(clientId: number) {
            for(let index = 0; index < this.entries.length; index++)
                if(this.entries[index].owner == clientId) this.entries[index].owner = 0;
        }

        constructor(index: number, name: string, type: CodecType){
            this.codecIndex = index;
            this.name = name;
            this.type = type;

            this._supported = this.type !== undefined && codec_supported(this.type);
        }
    }
}

export enum VoiceEncodeType {
    JS_ENCODE,
    NATIVE_ENCODE
}

export class VoiceConnection extends AbstractVoiceConnection {
    readonly connection: ServerConnection;

    rtcPeerConnection: RTCPeerConnection;
    dataChannel: RTCDataChannel;

    private _type: VoiceEncodeType = VoiceEncodeType.NATIVE_ENCODE;

    /*
     * To ensure we're not sending any audio because the settings activates the input,
     * we self mute the audio stream
     */
    local_audio_mute: GainNode;
    local_audio_stream: MediaStreamAudioDestinationNode;

    static codec_pool: codec.CodecPool[];

    static codecSupported(type: number) : boolean {
        return this.codec_pool && this.codec_pool.length > type && this.codec_pool[type].supported();
    }

    private voice_packet_id: number = 0;
    private chunkVPacketId: number = 0;
    private send_task: NodeJS.Timer;

    private _audio_source: RecorderProfile;
    private _audio_clients: VoiceClientController[] = [];

    private _encoder_codec: number = 5;

    constructor(connection: ServerConnection) {
        super(connection);
        this.connection = connection;

        this._type = settings.static_global("voice_connection_type", this._type);
    }

    destroy() {
        clearInterval(this.send_task);
        this.drop_rtp_session();
        this.acquire_voice_recorder(undefined, true).catch(error => {
            log.warn(LogCategory.VOICE, tr("Failed to release voice recorder: %o"), error);
        }).then(() => {
            for(const client of this._audio_clients)  {
                client.abort_replay();
                client.callback_playback = undefined;
                client.callback_state_changed = undefined;
                client.callback_stopped = undefined;
            }
            this._audio_clients = undefined;
            this._audio_source = undefined;
        });
    }

    static native_encoding_supported() : boolean {
        const context = window.webkitAudioContext || window.AudioContext;
        if(!context)
            return false;

        if(!context.prototype.createMediaStreamDestination)
            return false; //Required, but not available within edge

        return true;
    }

    static javascript_encoding_supported() : boolean {
        if(!window.RTCPeerConnection)
            return false;
        if(!RTCPeerConnection.prototype.createDataChannel)
            return false;
        return true;
    }

    current_encoding_supported() : boolean {
        switch (this._type) {
            case VoiceEncodeType.JS_ENCODE:
                return VoiceConnection.javascript_encoding_supported();
            case VoiceEncodeType.NATIVE_ENCODE:
                return VoiceConnection.native_encoding_supported();
        }
        return false;
    }

    private setup_native() {
        log.info(LogCategory.VOICE, tr("Setting up native voice stream!"));
        if(!VoiceConnection.native_encoding_supported()) {
            log.warn(LogCategory.VOICE, tr("Native codec isn't supported!"));
            return;
        }

        if(!this.local_audio_stream) {
            this.local_audio_stream = aplayer.context().createMediaStreamDestination();
        }
        if(!this.local_audio_mute) {
            this.local_audio_mute = aplayer.context().createGain();
            this.local_audio_mute.connect(this.local_audio_stream);
            this.local_audio_mute.gain.value = 1;
        }
    }

    private setup_js() {
        if(!VoiceConnection.javascript_encoding_supported()) return;
        if(!this.send_task)
            this.send_task = setInterval(this.send_next_voice_packet.bind(this), 20); /* send all 20ms out voice packets */
    }

    async acquire_voice_recorder(recorder: RecorderProfile | undefined, enforce?: boolean) {
        if(this._audio_source === recorder && !enforce)
            return;

        if(recorder)
            await recorder.unmount();

        if(this._audio_source)
            await this._audio_source.unmount();

        this.handle_local_voice_ended();
        this._audio_source = recorder;

        if(recorder) {
            recorder.current_handler = this.connection.client;

            recorder.callback_unmount = this.on_recorder_yield.bind(this);
            recorder.callback_start = this.handle_local_voice_started.bind(this);
            recorder.callback_stop = this.handle_local_voice_ended.bind(this);

            recorder.callback_input_change = async (old_input, new_input) => {
                if(old_input) {
                    try {
                        await old_input.set_consumer(undefined);
                    } catch(error) {
                        log.warn(LogCategory.VOICE, tr("Failed to release own consumer from old input: %o"), error);
                    }
                }
                if(new_input) {
                    if(this._type == VoiceEncodeType.NATIVE_ENCODE) {
                        if(!this.local_audio_stream)
                            this.setup_native(); /* requires initialized audio */

                        try {
                            await new_input.set_consumer({
                                type: InputConsumerType.NODE,
                                callback_node: node => {
                                    if(!this.local_audio_stream || !this.local_audio_mute)
                                        return;

                                    node.connect(this.local_audio_mute);
                                },
                                callback_disconnect: node => {
                                    if(!this.local_audio_mute)
                                        return;

                                    node.disconnect(this.local_audio_mute);
                                }
                            } as NodeInputConsumer);
                            log.debug(LogCategory.VOICE, tr("Successfully set/updated to the new input for the recorder"));
                        } catch (e) {
                            log.warn(LogCategory.VOICE, tr("Failed to set consumer to the new recorder input: %o"), e);
                        }
                    } else {
                        //TODO: Error handling?
                        await recorder.input.set_consumer({
                            type: InputConsumerType.CALLBACK,
                            callback_audio: buffer => this.handle_local_voice(buffer, false)
                        } as CallbackInputConsumer);
                    }
                }
            };
        }
        this.connection.client.update_voice_status(undefined);
    }

    get_encoder_type() : VoiceEncodeType { return this._type; }
    set_encoder_type(target: VoiceEncodeType) {
        if(target == this._type) return;
        this._type = target;

        if(this._type == VoiceEncodeType.NATIVE_ENCODE)
            this.setup_native();
        else
            this.setup_js();
        this.start_rtc_session();
    }

    voice_playback_support() : boolean {
        return this.dataChannel && this.dataChannel.readyState == "open";
    }

    voice_send_support() : boolean {
        if(this._type == VoiceEncodeType.NATIVE_ENCODE)
            return VoiceConnection.native_encoding_supported() && this.rtcPeerConnection.getLocalStreams().length > 0;
        else
            return this.voice_playback_support();
    }

    private voice_send_queue: {data: Uint8Array, codec: number}[] = [];
    handleEncodedVoicePacket(data: Uint8Array, codec: number){
        this.voice_send_queue.push({data: data, codec: codec});
    }

    private send_next_voice_packet() {
        const buffer = this.voice_send_queue.pop_front();
        if(!buffer)
            return;
        this.send_voice_packet(buffer.data, buffer.codec);
    }

    send_voice_packet(encoded_data: Uint8Array, codec: number) {
        if(this.dataChannel) {
            this.voice_packet_id++;
            if(this.voice_packet_id > 65535)
                this.voice_packet_id = 0;

            let packet = new Uint8Array(encoded_data.byteLength + 5);
            packet[0] = this.chunkVPacketId++ < 5 ? 1 : 0; //Flag header
            packet[1] = 0; //Flag fragmented
            packet[2] = (this.voice_packet_id >> 8) & 0xFF; //HIGHT (voiceID)
            packet[3] = (this.voice_packet_id >> 0) & 0xFF; //LOW   (voiceID)
            packet[4] = codec; //Codec
            packet.set(encoded_data, 5);
            try {
                this.dataChannel.send(packet);
            } catch (error) {
                log.warn(LogCategory.VOICE, tr("Failed to send voice packet. Error: %o"), error);
            }
        } else {
            log.warn(LogCategory.VOICE, tr("Could not transfer audio (not connected)"));
        }
    }

    private _audio_player_waiting = false;
    start_rtc_session() {
        if(!aplayer.initialized()) {
            log.info(LogCategory.VOICE, tr("Audio player isn't initialized yet. Waiting for gesture."));
            if(!this._audio_player_waiting) {
                this._audio_player_waiting = true;
                aplayer.on_ready(() => this.start_rtc_session());
            }
            return;
        }

        if(!this.current_encoding_supported())
            return false;

        if(this._type == VoiceEncodeType.NATIVE_ENCODE)
            this.setup_native();
        else
            this.setup_js();

        this.drop_rtp_session();
        this._ice_use_cache = true;


        let config: RTCConfiguration = {};
        config.iceServers = [];
        config.iceServers.push({ urls: 'stun:stun.l.google.com:19302' });
        this.rtcPeerConnection = new RTCPeerConnection(config);
        const dataChannelConfig = { ordered: true, maxRetransmits: 0 };

        this.dataChannel = this.rtcPeerConnection.createDataChannel('main', dataChannelConfig);
        this.dataChannel.onmessage = this.on_data_channel_message.bind(this);
        this.dataChannel.onopen = this.on_data_channel.bind(this);
        this.dataChannel.binaryType = "arraybuffer";

        let sdpConstraints : RTCOfferOptions = {};
        sdpConstraints.offerToReceiveAudio = this._type == VoiceEncodeType.NATIVE_ENCODE;
        sdpConstraints.offerToReceiveVideo = false;
        sdpConstraints.voiceActivityDetection = true;

        this.rtcPeerConnection.onicecandidate = this.on_local_ice_candidate.bind(this);
        if(this.local_audio_stream) { //May a typecheck?
            this.rtcPeerConnection.addStream(this.local_audio_stream.stream);
            log.info(LogCategory.VOICE, tr("Adding native audio stream (%o)!"), this.local_audio_stream.stream);
        }

        this.rtcPeerConnection.createOffer(sdpConstraints)
            .then(offer => this.on_local_offer_created(offer))
            .catch(error => {
                log.error(LogCategory.VOICE, tr("Could not create ice offer! error: %o"), error);
            });
    }

    drop_rtp_session() {
        if(this.dataChannel) {
            this.dataChannel.close();
            this.dataChannel = undefined;
        }

        if(this.rtcPeerConnection) {
            this.rtcPeerConnection.close();
            this.rtcPeerConnection = undefined;
        }

        this._ice_use_cache = true;
        this._ice_cache = [];

        this.connection.client.update_voice_status(undefined);
    }

    private _ice_use_cache: boolean = true;
    private _ice_cache: any[] = [];
    handleControlPacket(json) {
        if(json["request"] === "answer") {
            const session_description = new RTCSessionDescription(json["msg"]);
            log.info(LogCategory.VOICE, tr("Received answer to our offer. Answer: %o"), session_description);
            this.rtcPeerConnection.setRemoteDescription(session_description).then(() => {
                log.info(LogCategory.VOICE, tr("Answer applied successfully. Applying ICE candidates (%d)."), this._ice_cache.length);
                this._ice_use_cache = false;
                for(let msg of this._ice_cache) {
                    this.rtcPeerConnection.addIceCandidate(new RTCIceCandidate(msg)).catch(error => {
                        log.info(LogCategory.VOICE, tr("Failed to add remote cached ice candidate %s: %o"), msg, error);
                    });
                }
                this._ice_cache = [];
            }).catch(error => {
                log.info(LogCategory.VOICE, tr("Failed to apply remote description: %o"), error); //FIXME error handling!
            });
        } else if(json["request"] === "ice") {
            if(!this._ice_use_cache) {
                log.info(LogCategory.VOICE, tr("Add remote ice! (%o)"), json["msg"]);
                this.rtcPeerConnection.addIceCandidate(new RTCIceCandidate(json["msg"])).catch(error => {
                    log.info(LogCategory.VOICE, tr("Failed to add remote ice candidate %s: %o"), json["msg"], error);
                });
            } else {
                log.info(LogCategory.VOICE, tr("Cache remote ice! (%o)"), json["msg"]);
                this._ice_cache.push(json["msg"]);
            }
        } else if(json["request"] == "status") {
            if(json["state"] == "failed") {
                const chandler = this.connection.client;
                chandler.log.log(elog.Type.CONNECTION_VOICE_SETUP_FAILED, {
                    reason: json["reason"],
                    reconnect_delay: json["allow_reconnect"] ? 1 : 0
                });
                log.error(LogCategory.NETWORKING, tr("Failed to setup voice bridge (%s). Allow reconnect: %s"), json["reason"], json["allow_reconnect"]);
                if(json["allow_reconnect"] == true) {
                    this.start_rtc_session();
                }
                //TODO handle fail specially when its not allowed to reconnect
            }
        }
    }

    private on_local_ice_candidate(event: RTCPeerConnectionIceEvent) {
        if (event) {
            //if(event.candidate && event.candidate.protocol !== "udp")
            //    return;

            log.info(LogCategory.VOICE, tr("Gathered local ice candidate %o."), event.candidate);
            if(event.candidate) {
                this.connection.sendData(JSON.stringify({
                    type: 'WebRTC',
                    request: "ice",
                    msg: event.candidate,
                }));
            } else {
                this.connection.sendData(JSON.stringify({
                    type: 'WebRTC',
                    request: "ice_finish"
                }));
            }
        }
    }

    private on_local_offer_created(localSession) {
        log.info(LogCategory.VOICE, tr("Local offer created. Setting up local description. (%o)"), localSession);
        this.rtcPeerConnection.setLocalDescription(localSession).then(() => {
            log.info(LogCategory.VOICE, tr("Offer applied successfully. Sending offer to server."));
            this.connection.sendData(JSON.stringify({type: 'WebRTC', request: "create", msg: localSession}));
        }).catch(error => {
            log.info(LogCategory.VOICE, tr("Failed to apply local description: %o"), error);
            //FIXME error handling
        });
    }

    private on_data_channel(channel) {
        log.info(LogCategory.VOICE, tr("Got new data channel! (%s)"), this.dataChannel.readyState);

        this.connection.client.update_voice_status();
    }

    private on_data_channel_message(message: MessageEvent) {
        const chandler = this.connection.client;
        if(chandler.client_status.output_muted) /* we dont need to do anything with sound playback when we're not listening to it */
            return;

        let bin = new Uint8Array(message.data);
        let clientId = bin[2] << 8 | bin[3];
        let packetId = bin[0] << 8 | bin[1];
        let codec = bin[4];
        //log.info(LogCategory.VOICE, "Client id " + clientId + " PacketID " + packetId + " Codec: " + codec);
        let client = this.find_client(clientId);
        if(!client) {
            log.error(LogCategory.VOICE, tr("Having voice from unknown audio client? (ClientID: %o)"), clientId);
            return;
        }

        let codec_pool = VoiceConnection.codec_pool[codec];
        if(!codec_pool) {
            log.error(LogCategory.VOICE, tr("Could not playback codec %o"), codec);
            return;
        }

        let encodedData;
        if(message.data.subarray)
            encodedData = message.data.subarray(5);
        else encodedData = new Uint8Array(message.data, 5);

        if(encodedData.length == 0) {
            client.stopAudio();
            codec_pool.releaseCodec(clientId);
        } else {
            codec_pool.ownCodec(clientId, e => this.handleEncodedVoicePacket(e, codec), true)
                .then(decoder => decoder.decodeSamples(client.get_codec_cache(codec), encodedData))
                .then(buffer => client.playback_buffer(buffer)).catch(error => {
                log.error(LogCategory.VOICE, tr("Could not playback client's (%o) audio (%o)"), clientId, error);
                if(error instanceof Error)
                    log.error(LogCategory.VOICE, error.stack);
            });
        }
    }

    private handle_local_voice(data: AudioBuffer, head: boolean) {
        const chandler = this.connection.client;
        if(!chandler.connected)
            return false;

        if(chandler.client_status.input_muted)
            return false;

        if(head)
            this.chunkVPacketId = 0;

        let client = this.find_client(chandler.clientId);
        if(!client) {
            log.error(LogCategory.VOICE, tr("Tried to send voice data, but local client hasn't a voice client handle"));
            return;
        }

        const codec = this._encoder_codec;
        VoiceConnection.codec_pool[codec]
            .ownCodec(chandler.getClientId(), e => this.handleEncodedVoicePacket(e, codec), true)
            .then(encoder => encoder.encodeSamples(client.get_codec_cache(codec), data));
    }

    private handle_local_voice_ended() {
        const chandler = this.connection.client;
        const ch = chandler.getClient();
        if(ch) ch.speaking = false;

        if(!chandler.connected)
            return false;
        if(chandler.client_status.input_muted)
            return false;
        log.info(LogCategory.VOICE, tr("Local voice ended"));

        if(this.dataChannel && this._encoder_codec >= 0)
            this.send_voice_packet(new Uint8Array(0), this._encoder_codec);
    }

    private handle_local_voice_started() {
        const chandler = this.connection.client;
        if(chandler.client_status.input_muted) {
            /* evail hack due to the settings :D */
            log.warn(LogCategory.VOICE, tr("Received local voice started event, even thou we're muted! Do not send any voice."));
            if(this.local_audio_mute)
                this.local_audio_mute.gain.value = 0;
            return;
        }
        if(this.local_audio_mute)
            this.local_audio_mute.gain.value = 1;
        log.info(LogCategory.VOICE, tr("Local voice started"));

        const ch = chandler.getClient();
        if(ch) ch.speaking = true;
    }

    private on_recorder_yield() {
        log.info(LogCategory.VOICE, "Lost recorder!");
        this._audio_source = undefined;
        this.acquire_voice_recorder(undefined, true); /* we can ignore the promise because we should finish this directly */
    }

    connected(): boolean {
        return typeof(this.dataChannel) !== "undefined" && this.dataChannel.readyState === "open";
    }

    voice_recorder(): RecorderProfile {
        return this._audio_source;
    }

    available_clients(): VoiceClient[] {
        return this._audio_clients;
    }

    find_client(client_id: number) : VoiceClientController | undefined {
        for(const client of this._audio_clients)
            if(client.client_id === client_id)
                return client;
        return undefined;
    }

    unregister_client(client: VoiceClient): Promise<void> {
        if(!(client instanceof VoiceClientController))
            throw "Invalid client type";

        this._audio_clients.remove(client);
        return Promise.resolve();
    }

    register_client(client_id: number): VoiceClient {
        const client = new VoiceClientController(client_id);
        this._audio_clients.push(client);
        return client;
    }

    decoding_supported(codec: number): boolean {
        return VoiceConnection.codecSupported(codec);
    }

    encoding_supported(codec: number): boolean {
        return VoiceConnection.codecSupported(codec);
    }

    get_encoder_codec(): number {
        return this._encoder_codec;
    }

    set_encoder_codec(codec: number) {
        this._encoder_codec = codec;
    }
}



/* funny fact that typescript dosn't find this */
declare global {
    interface RTCPeerConnection {
        addStream(stream: MediaStream): void;
        getLocalStreams(): MediaStream[];
        getStreamById(streamId: string): MediaStream | null;
        removeStream(stream: MediaStream): void;
        createOffer(successCallback?: RTCSessionDescriptionCallback, failureCallback?: RTCPeerConnectionErrorCallback, options?: RTCOfferOptions): Promise<RTCSessionDescription>;
    }
}

loader.register_task(loader.Stage.JAVASCRIPT_INITIALIZING, {
    priority: 10,
    function: async () => {
        aplayer.on_ready(() => {
            log.info(LogCategory.VOICE, tr("Initializing voice handler after AudioController has been initialized!"));

            VoiceConnection.codec_pool = [
                new codec.CodecPool(0, tr("Speex Narrowband"), CodecType.SPEEX_NARROWBAND),
                new codec.CodecPool(1, tr("Speex Wideband"), CodecType.SPEEX_WIDEBAND),
                new codec.CodecPool(2, tr("Speex Ultra Wideband"), CodecType.SPEEX_ULTRA_WIDEBAND),
                new codec.CodecPool(3, tr("CELT Mono"), CodecType.CELT_MONO),
                new codec.CodecPool(4, tr("Opus Voice"), CodecType.OPUS_VOICE),
                new codec.CodecPool(5, tr("Opus Music"), CodecType.OPUS_MUSIC)
            ];

            VoiceConnection.codec_pool[4].initialize(2);
            VoiceConnection.codec_pool[5].initialize(2);
        });
    },
    name: "registering codec initialisation"
});
