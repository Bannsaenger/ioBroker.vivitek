/*
 * Created with @iobroker/create-adapter v1.26.3
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
const fs = require('fs');
const net = require('net');
const util = require('util');

class Vivitek extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'vivitek',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        // read Objects template for object generation
        this.objectsTemplate = JSON.parse(fs.readFileSync(__dirname + '/admin/objects_templates.json', 'utf8'));

        // Status of the projector under control
        this.projector = {
            connected : false,
            status : '',
            input : '',
            blank : false,
            powerOn : false,
            waitForAnswer : false,
            activeCommand : '',         // the text string to send
            telegramPart : ''
        };

        // Send buffer (Array of command object)
        this.sendBuffer = [];

        // activeCommand = POLLING, status, power.on, power.off, blank, input.sel
        // Timer values. Not declared because of type errors
        // timerReconnect : {},
        // timerWaitForAnswer : {},
        // intervallQueryStatus : {},
        // timerInactivityTimeout : {}

        this.inputs = {
            '1' : 'RGB',
            '3' : 'DVI',
            '4' : 'Video',
            '6' : 'HDMI 1',
            '7' : 'BNC',
            '9' : 'HDMI 2',
            '15' : 'HDBaseT'
        };

        // Create a client socket to connect to the projector
        this.client = new net.Socket();
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        const self = this;
        // Initialize your adapter here

        // Reset the connection indicator during startup
        this.setState('info.connection', false, true);

        // The adapters config (in the instance object everything under the attribute "native") is accessible via
        // this.config:
        this.log.info('configured host/port: ' + this.config.host + ':' + this.config.port);

        /*
        For every state in the system there has to be also an object of type state
        */
        /**
         * @param {ioBroker.SettableObject} element
         */
        this.objectsTemplate.common.forEach(async element => {
            await self.setObjectNotExistsAsync(element._id, element);
        });

        if (this.config.projectorType in this.objectsTemplate.projectors) {
            this.objectsTemplate.projectors[this.config.projectorType].states.forEach(async element => {
                await self.setObjectNotExistsAsync(this.objectsTemplate.states[element]._id, this.objectsTemplate.states[element]);
            });
        } else {
            this.log.error('Vivitek Projector Type: "' + this.config.projectorType + '" not found');
        }

        // In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
        this.subscribeStates('power');
        this.subscribeStates('input');
        this.subscribeStates('blank');

        /*
            getState
            read the necessary states to get started
        */
        let tempState = await self.getStateAsync('input');
        // @ts-ignore
        if (tempState) this.projector.input = tempState.val.toString() || '6';
        tempState = await self.getStateAsync('blank');
        this.projector.blank = false;
        // @ts-ignore
        if (tempState && tempState.val) this.projector.blank = true;

        // Client callbacks
        this.client.on('error', this.onClientError.bind(this));
        this.client.on('connect', this.onClientConnect.bind(this));
        this.client.on('data', this.onClientData.bind(this));
        this.client.on('close', this.onClientClose.bind(this));

        this.clientConnect();
    }

    /**
     * try to connect to the projector
     */
    async clientConnect() {
        this.log.info('Vivitek connecting to: ' + this.config.host + ':' + this.config.port);
        this.client.connect(this.config.port, this.config.host);
    }

    /**
     * try to reconnect to the projector
     */
    clientReconnect() {
        this.log.info('Vivitek try to reconnect in: ' + this.config.reconnectDelay + 'ms');
        this.projector.timerReconnect = setTimeout(this.clientConnect.bind(this), this.config.reconnectDelay);
    }

    /**
     * called if client is connected
     */
    onClientConnect() {
        this.setConnection(true);
        this.clientDoPolling();
    }

    /**
     * called for sending data (adding to the queue)
     * @param {any} data
     */
    clientSendData(data) {
        // Add command to the send buffer
        this.sendBuffer.push(data);

        if (!this.projector.waitForAnswer) {    // if sending is possible
            this.clientSendNext();
        }
    }

    /**
     * send next command in the queue
     */
    clientSendNext() {
        if (this.sendBuffer.length > 0) {
            const localBuffer = this.sendBuffer.shift();
            this.log.debug('Vivitek send data: "' + localBuffer.command + '"');
            this.projector.waitForAnswer = true;
            this.projector.timerWaitForAnswer = setTimeout(this.onClientWaitForAnswerExceeded.bind(this), this.config.answerTimeout);
            this.projector.activeCommand = localBuffer.command;
            this.client.write(localBuffer.command + '\r');
        }
    }

    /**
     * called if timeout for the answer has exceeded
     */
    onClientWaitForAnswerExceeded() {
        this.projector.waitForAnswer = false;
        this.projector.activeCommand = '';
        this.log.warn('Answer timeout exceeded');
    }

    /**
     * called if inactivity timeout has exceeded
     */
    onClientInactivityTimeoutExceeded() {
        this.projector.waitForAnswer = false;
        this.projector.activeCommand = '';
        this.onClientError('Inactivity timeout exceeded');
    }

    /**
     * called if client is connected then polling will be started and when intervall exceeds
     */
    clientDoPolling() {
        this.log.silly('Vivitek send polling, query status');
        if (!this.projector.intervallQueryPower) {
            this.projector.intervallQueryPower = setInterval(this.clientDoPolling.bind(this), this.config.pollDelay);
        }
        this.clientSendData({command : 'op status ?'});
    }

    /**
     * called if projector is to be powerd on or off
     * @param {string} func
     * func can be on, off or toggle
     */
    projectorOnOff(func = 'toggle') {
        this.log.info('Vivitek switch projector power: "' + func + '"');
        let powerCommand = '';

        if (func === 'toggle') {
            if (this.projector.status === '1') {        // projector is in standby, switch on
                powerCommand = 'on';
            }
            if (this.projector.status === '2') {        // projector is active, switch off
                powerCommand = 'off';
            }
        }
        if (func === 'on'  && this.projector.status === '1') powerCommand = 'on';   // only if projector in standby
        if (func === 'off' && this.projector.status === '1') powerCommand = 'off';  // only if projector is active

        if (powerCommand !== '') {      // something to do ?
            this.clientSendData({command : 'op power.' + powerCommand});
        }
    }

    /**
     * called if projector has to switch his input
     * @param {string} input
     * input is 1 : RGB 3 : DVI 4 : Video 6 : HDMI 1 7 : BNC 9 : HDMI 2 15 : HDBaseT
     */
    projectorSetInput(input = '6') {
        if (this.projector.status === '2') {        // only if projector active
            this.log.info('Vivitek switch projector input: "' + input + '" "' + this.inputs[input] + '"');
            this.clientSendData({command : 'op input.sel = ' + input});
        } else {
            this.log.info('Vivitek switch projector input not possible [not connected]');
        }
    }

    /**
     * called if projector has to set its blank option
     * @param {string} input
     * input is true or false
     */
    projectorSetBlank(input = 'true') {
        if (this.projector.status === '2') {        // only if projector active
            this.log.info('Vivitek projector set blank state: "' + input + '"');
            if (input === 'true') {
                this.clientSendData({command : 'op blank = 1'});
            } else  {
                this.clientSendData({command : 'op blank = 0'});
            }
        } else {
            this.log.info('Vivitek projector set blank not possible [not connected]');
        }
    }

    /**
     * called if client receives data
     * @param {Uint8Array} data
     */
    async onClientData(data) {
        let dataString = new util.TextDecoder('utf-8').decode(data);

        if (dataString.includes('\r') || dataString.includes('\n')) {     // strip CR and LF
            dataString = dataString.replace(/\n|\r/g, '');
            this.log.silly('Vivitek got data fragment with CR: "' + dataString + '"');
            this.projector.telegramPart += dataString;
            if (this.projector.telegramPart) {
                await this.parseClientData(this.projector.telegramPart);
            }
            this.projector.telegramPart = '';
        } else {
            this.log.silly('Vivitek got data fragment: "' + dataString + '"');
            this.projector.telegramPart += dataString;
        }
    }

    /**
     * called if client data package is complete
     * @param {string} data
     */
    async parseClientData(data) {
        this.log.debug('Vivitek got data: "' + data + '"');
        // now parse the answer
        const recData = String(data).substr(-1) === '\r' ? String(data).substr(0, String(data).length - 1) : String(data);
        let retriggerInactivityTimeout = false;
        if (!recData) {
            this.log.error('Vivitek received empty data');
        } else if (recData === '*Illegal format#') {   // error message
            this.log.error('Vivitek projector sent an <*Illegal format#> error');
        } else if (recData.toUpperCase() === 'F') {
            this.log.error('Vivitek projector sent an error');
        } else {                                                        // regular command
            const recCommand = recData.split(' ');
            let recPrefix = '';
            let recSetting = '';
            let recOperator = '';
            let recValue = '';
            if (recCommand.length == 2) {                               // command without =
                recPrefix = recCommand[0].toUpperCase();
                recSetting = recCommand[1].toUpperCase();
            } else if (recCommand.length == 3) {                        // maybe OP POWER ON
                recPrefix = recCommand[0].toUpperCase();
                recSetting = recCommand[1].toUpperCase();
                recValue = recCommand[2];
            } else if (recCommand.length == 4) {                        // command with operator
                recPrefix = recCommand[0].toUpperCase();
                recSetting = recCommand[1].toUpperCase();
                recOperator = recCommand[2].toUpperCase();
                recValue = recCommand[3];
            } else {
                this.log.error('Vivitek projector sent a unknown format (parsing error)');
            }

            if (recOperator !== '=' && recOperator !== '') {
                this.log.warn('Vivitek operator not yet supported: "' + recOperator + '"');
            }

            if (recValue === 'NA') {
                this.log.warn('Vivitek projector was not ready to accept data (not applicable)');
            }
            else if (recPrefix === 'OP') {                              // regular telegram
                let isTrueSet = false;
                switch (recSetting) {
                    case 'POWER.ON':
                        this.log.debug('Vivitek projector is now switched on');
                        retriggerInactivityTimeout = true;
                        break;
                    case 'POWER.OFF':
                        this.log.debug('Vivitek projector is now switched off');
                        retriggerInactivityTimeout = true;
                        break;
                    case 'POWER':
                        if (recValue === 'ON') {
                            this.log.debug('Vivitek projector is now switched on');
                            retriggerInactivityTimeout = true;
                        } else if (recValue === 'OFF') {
                            this.log.debug('Vivitek projector is now switched on');
                            retriggerInactivityTimeout = true;
                        } else {
                            this.log.debug('Vivitek projector sent an unknown power command "' + recValue + '"');
                        }
                        break;
                    case 'RESET.ALL':
                        this.log.debug('Vivitek projector is now resetted');
                        retriggerInactivityTimeout = true;
                        break;
                    case 'STATUS':
                        if (this.projector.status !== recValue){   // new status arrived
                            this.projector.status = recValue;
                            this.setState('status',this.projector.status , true);
                            if (this.projector.status === '2') {        // set defaults if status is active for the first time
                                this.projectorSetBlank(this.projector.blank.toString());
                                this.projectorSetInput(this.projector.input);
                            }
                        }
                        retriggerInactivityTimeout = true;
                        break;
                    case 'INPUT.SEL':
                        if (this.projector.input !== recValue){    // new status arrived
                            this.projector.input = recValue;
                            this.setState('input',this.projector.input , true);
                        }
                        retriggerInactivityTimeout = true;
                        break;
                    case 'BLANK':
                        isTrueSet = (recValue === '1');
                        if (this.projector.blank !== isTrueSet){        // new status arrived
                            this.projector.blank = isTrueSet;
                            this.setState('blank',this.projector.blank , true);
                        }
                        retriggerInactivityTimeout = true;
                        break;
                    default:
                        this.log.warn('Vivitek command not yet supported: "' + recCommand + '"');
                }
            } else {
                this.log.warn('Vivitek prefix not yet supported: "' + recPrefix + '"');
            }
        }

        this.projector.waitForAnswer = false;       // now we have received the answer
        if (this.projector.timerWaitForAnswer) clearTimeout(this.projector.timerWaitForAnswer);
        if (retriggerInactivityTimeout) {
            this.log.debug('Vivitek refreshing inactivity Timeout');
            if (this.projector.timerInactivityTimeout) this.projector.timerInactivityTimeout.refresh();
        } else {
            this.log.silly('Vivitek data without refreshing inactivity Timeout');
        }
        this.clientSendNext();
    }

    /**
     * called if client is closed
     */
    onClientClose() {
        if(this.projector.connected){
            this.setConnection(false);
        }
    }

    /**
     * called if client receives an error
     * @param {any} err
     */
    async onClientError(err) {
        this.log.error('Vivitek Error: ' + err);
        this.setConnection(false);
        if (err.code == 'ENOTFOUND' || err.code == 'ECONNREFUSED' || err.code == 'ETIMEDOUT' || err == 'Inactivity timeout exceeded') {
            this.log.info('Vivitek destroy net socket');
            this.client.destroy();
        }
        this.clientReconnect();
    }

    /**
     * Is called to set the connection state in db and log
     * @param {boolean} status
     */
    setConnection(status) {
        if (status){
            this.projector.connected = true;
            this.log.info('Vivitek projector connected.');
            this.setState('info.connection', true, true);
            if (this.projector.timerReconnect) clearTimeout(this.projector.timerReconnect);
            if (this.projector.timerWaitForAnswer) clearTimeout(this.projector.timerWaitForAnswer);
            if (this.projector.timerInactivityTimeout) {
                this.projector.timerInactivityTimeout.refresh();
            } else {
                this.projector.timerInactivityTimeout = setTimeout(this.onClientInactivityTimeoutExceeded.bind(this), this.config.inactivityTimeout);
            }
        } else {
            this.projector.connected = false;
            this.log.info('Vivitek disconnected');
            this.setState('info.connection', false, true);
            if (this.projector.timerWaitForAnswer) clearTimeout(this.projector.timerWaitForAnswer);
            if (this.projector.intervallQueryPower) {
                clearInterval(this.projector.intervallQueryPower);
                this.projector.intervallQueryPower = undefined;                // for the reconnect, then the interval will be new set by clientDoPolling
            }
            if (this.projector.timerInactivityTimeout) clearTimeout(this.projector.inactivityTimeout);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            // clearInterval(interval1);

            // close client to sel the info connection and stop all timers
            this.client.destroy();

            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`Vivitek state ${id} changed: ${state.val} (ack = ${state.ack})`);
            if (!state.ack && state.val) {           // only if the state is set manually
                const onlyId = id.replace(this.namespace + '.', '');
                switch (onlyId) {
                    case 'power':
                        this.projectorOnOff();
                        break;
                    case 'input':
                        this.projectorSetInput(state.val.toString());
                        break;
                    case 'blank':
                        this.projectorSetBlank(state.val.toString());
                        break;
                }
            }
        }
    }

    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires "common.message" property to be set to true in io-package.json
     * @param {ioBroker.Message} obj
     */
    onMessage(obj) {
        this.log.silly('Vivitek message called');
        if (typeof obj === 'object' && obj.message) {
            if (obj.command === 'send') {
                // e.g. send email or pushover or whatever
                this.log.info('Vivitek received command object: "' + obj.message + '"');
                // Send response in callback if required
                if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
            }
        } else {
            this.log.info('Vivitek received command: "' + obj + '"');
        }
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => {'use strict'; new Vivitek(options); };
} else {
    // otherwise start the instance directly
    new Vivitek();
}