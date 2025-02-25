/* eslint-disable no-unused-vars */
/*jslint node: true */
'use strict';

// eslint-disable-next-line no-undef
if (process.env.DEBUG === '1') {
	require('inspector').open(9225, '0.0.0.0', false);
}

const Homey = require('homey');
let onvif = require('./lib/onvif');
let Cam = require('./lib/onvif').Cam;
const parseSOAPString = require('./lib/onvif/lib/utils').parseSOAPString;
const linerase = require('./lib/onvif/lib/utils').linerase;
const path = require('path');
const nodemailer = require('./lib/nodemailer');

const http = require('http');
const { promisify } = require('util');
class MyApp extends Homey.App
{

    async onInit()
    {
        this.log('MyApp is running...');

        this.pushServerPort = this.homey.settings.get('port');
        if (!this.pushServerPort)
        {
            this.pushServerPort = 9998;
            this.homey.settings.set('port', 9998);
        }

        this.discoveredDevices = [];
        this.discoveryInitialised = false;
        //this.homey.settings.set('diagLog', "");

        this.homeyId = await this.homey.cloud.getHomeyId();
        this.homeyHash = this.hashCode(this.homeyId).toString();

        this.homeyIP = await this.homey.cloud.getLocalAddress();
        this.homeyIP = (this.homeyIP.split(':'))[0];

        this.pushEvents = [];

        this.logLevel = this.homey.settings.get('logLevel');

        this.homey.settings.on('set', (setting) =>
        {
            if (setting === 'logLevel')
            {
                this.logLevel = this.homey.settings.get('logLevel');
            }
            if (setting == 'port')
            {
                this.pushServerPort = this.homey.settings.get('port');
                this.unregisterCameras();
                this.server.close();
                this.server.listen(this.pushServerPort);
            }
        });

        this.registerFlowCard().catch(this.error);

        this.server = null;
        try
        {
            await this.runsListener();
        }
        catch (err)
        {
            console.log('runsListener: ', err);
        }

        setImmediate(() =>
        {
            this.checkCameras();
        });

        this.homey.on('unload', () =>
        {
            if (this.server)
            {
                this.server.close();
                this.updateLog('Server closed', 0);
            }
            this.unregisterCameras();
        });

        this.homey.on('memwarn', (data) =>
        {
            if (data)
            {
                if (data.count >= data.limit - 2)
                {
                    this.homey.settings.set('diagLog', '');
                }
                this.updateLog(`memwarn! ${data.count} of ${data.limit}`, 0);
            }
            else
            {
                this.updateLog('memwarn', 0);
            }
        });

        this.homey.on('cpuwarn', (data) =>
        {
            if (data)
            {
                if (data.count >= data.limit - 2)
                {
                    this.updateLog('Closing server', 0);
                    if (this.server && this.server.listening)
                    {
                        this.server.close((err) =>
                        {
                            this.updateLog(`Server closed: ${err}`, 0);
                        });
                        this.server.closeAllConnections();
                        setTimeout(() =>
                        {
                            this.server.close();
                            this.server.listen(this.pushServerPort);
                        }, 300000);
                    }
                }
                this.updateLog(`cpuwarn! ${data.count} of ${data.limit}`, 0);
            }
            else
            {
                this.updateLog('cpuwarn', 0);
            }
        });
    }

    async registerFlowCard()
    {
        this.motionCondition = this.homey.flow.getConditionCard('motionEnabledCondition');
        this.motionCondition.registerRunListener(async (args, state) =>
        {
            return await args.device.getCapabilityValue('motion_enabled'); // Promise<boolean>
        });

        this.motionReadyCondition = this.homey.flow.getConditionCard('motionReadyCondition');
        this.motionReadyCondition.registerRunListener(async (args, state) =>
        {
            let remainingTime = args.waitTime * 10;
            while ((remainingTime > 0) && args.device.updatingEventImage)
            {
                // Wait for image to update
                await this.homey.app.asyncDelay(100);
                remainingTime--;
            }
            return !args.device.updatingEventImage;
        });

        this.motionEnabledAction = this.homey.flow.getActionCard('motionEnableAction');
        this.motionEnabledAction.registerRunListener(async (args, state) =>
        {
            console.log('motionEnabledAction');
            args.device.onCapabilityMotionEnable(true, null);
            return await args.device.setCapabilityValue('motion_enabled', true); // Promise<void>
        });

        this.motionDisabledAction = this.homey.flow.getActionCard('motionDisableAction');
        this.motionDisabledAction.registerRunListener(async (args, state) =>
        {

            console.log('motionDisabledAction');
            args.device.onCapabilityMotionEnable(false, null);
            return await args.device.setCapabilityValue('motion_enabled', false); // Promise<void>
        });

        this.snapshotAction = this.homey.flow.getActionCard('snapshotAction');
        this.snapshotAction.registerRunListener(async (args, state) =>
        {

            let err = await args.device.nowImage.update();
            if (!err)
            {
                let tokens = {
                    'image': args.device.nowImage
                };

                args.device.driver.snapshotReadyTrigger
                    .trigger(args.device, tokens)
                    .catch(args.device.error)
                    .then(args.device.log('Now Snapshot ready (' + args.device.id + ')'));
            }
            return err;
        });

        this.motionUpdateAction = this.homey.flow.getActionCard('updateMotionImageAction');
        this.motionUpdateAction.registerRunListener(async (args, state) =>
        {
            return args.device.updateMotionImage(0);
        });

		// Add action trigger for presets
		this.gotoPresetAction = this.homey.flow.getActionCard('goto_preset')
			.registerRunListener(async (args, state) =>
			{
				const device = args.device;
				const presetNumber = args.preset;
				return device.gotoPreset(presetNumber);
			});

        this.motionTrigger = this.homey.flow.getTriggerCard('global_motion_detected');

    }

    hashCode(s)
    {
        for (var i = 0, h = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
        return h;
    }

    getMessageToken(message)
    {
        if (message.source && message.source.simpleItem)
        {
            let simpleItem;
            if (Array.isArray(message.source.simpleItem))
            {
                simpleItem = message.source.simpleItem[0];
            }
            else
            {
                simpleItem = message.source.simpleItem;
            }

            if (simpleItem && simpleItem.$)
            {
                return simpleItem.$.Value;
            }
        }

        return null;
    }

    async processEventMessage(soapMsg, eventIP)
    {
        parseSOAPString(soapMsg, (err, res, xml) =>
        {
            if (!err && res)
            {
                let data = linerase(res).notify;

                if (data && data.notificationMessage)
                {
                    if (!Array.isArray(data.notificationMessage))
                    {
                        data.notificationMessage = [data.notificationMessage];
                    }

                    let messageToken = this.getMessageToken(data.notificationMessage[0].message.message);
                    this.updateLog(`Push event token: ${messageToken}`, 1);

                    // Find the referenced device
                    const driver = this.homey.drivers.getDriver('camera');
                    let theDevice = null;
                    if (driver)
                    {
                        let devices = driver.getDevices();
                        for (let i = 0; i < devices.length; i++)
                        {
                            let device = devices[i];
                            if (device.ip == eventIP)
                            {
                                // Correct IP so check the token for multiple cameras on this IP
                                if (!device.token || !messageToken || (messageToken == device.token))
                                {
                                    theDevice = device;
                                    if (this.logLevel >= 2)
                                    {
                                        this.updateLog('Push Event found correct Device: ' + device.token);
                                    }
                                    break;
                                }
                                else
                                {
                                    if (this.logLevel >= 2)
                                    {
                                        this.updateLog('Wrong channel token');
                                    }
                                }
                            }
                        }
                    }

                    if (theDevice)
                    {
                        data.notificationMessage.forEach((message) =>
                        {
                            if (this.logLevel >= 2)
                            {
                                this.updateLog('Push Event process: ' + this.varToString(message));
                            }
                            theDevice.processCamEventMessage(message);
                        });
                    }
                    else
                    {
                        this.updateLog('Push Event unknown Device: ' + eventIP, 0);
                    }
                }
            }
            else
            {
                this.updateLog('Push data error: ' + err, 0);
            }
        });
    }

    async runsListener()
    {
        const requestListener = (request, response) =>
        {
            let pathParts = request.url.split('/');

            if ((pathParts[1] === 'onvif') && (pathParts[2] === 'events') && request.method === 'POST')
            {
                let eventIP = pathParts[3];
                if (request.headers['content-type'].startsWith('application/soap+xml'))
                {
                    let body = '';
                    request.on('data', chunk =>
                    {
                        body += chunk.toString(); // convert Buffer to string
                        if (body.length > 50000)
                        {
                            this.updateLog('Push data error: Payload too large', 0);
                            response.writeHead(413);
                            response.end('Payload Too Large');
                            body = '';
                            return;
                        }
                    });
                    request.on('end', () =>
                    {
                        let soapMsg = body;
                        body = '';
                        response.writeHead(200);
                        response.end('ok');
                        if (this.logLevel >= 3)
                        {
                            this.updateLog('Push event: ' + soapMsg, 3);
                        }
                        else
                        {
                            this.updateLog(`Push event: ${eventIP}`, 1);
                        }
                        this.processEventMessage(soapMsg, eventIP);
                    });
                }
                else
                {
                    this.updateLog('Push data invalid content type: ' + request.headers['content-type'], 0);
                    response.writeHead(415);
                    response.end('Unsupported Media Type');
                }
            }
            else
            {
                this.updateLog('Push data error: ' + request.url + ': METHOD = ' + request.method, 0);
                response.writeHead(405);
                response.end('Method not allowed');
            }
        };

        this.server = http.createServer(requestListener);
        this.server.on('error', (e) =>
        {
            if (e.code === 'EADDRINUSE')
            {
                this.updateLog(`Server port ${this.pushServerPort} in use, retrying in 10 seconds`, 0);
                setTimeout(() =>
                {
                    this.server.close();
                    this.server.listen(this.pushServerPort);
                }, 10000);
            }
        });

        try
        {
            this.server.listen(this.pushServerPort);
        }
        catch (err)
        {
            this.log(err);
        }
    }

    async discoverCameras()
    {
        this.discoveredDevices = [];
        this.updateLog('====  Discovery Starting  ====');
        if (!this.discoveryInitialised)
        {
            this.discoveryInitialised = true;
            onvif.Discovery.on('device', async (cam, rinfo, xml) =>
            {
                try
                {
                    // function will be called as soon as NVT responds
                    this.updateLog('Reply from ' + this.varToString(cam), 1);

                    if (cam.href && cam.href.indexOf('onvif') >= 0)
                    {
                        let mac = null;
                        try
                        {
                            mac = await this.homey.arp.getMAC(cam.hostname);
                        }
                        catch (err)
                        {
                            this.log('Failed to get mac address', err);
                            mac = cam.urn;
                        }

                        this.discoveredDevices.push(
                            {
                                'name': cam.hostname,
                                data:
                                {
                                    'id': cam.urn ? cam.urn : mac
                                },
                                settings:
                                {
                                    // Store username & password in settings
                                    // so the user can change them later
                                    'username': '',
                                    'password': '',
                                    'ip': cam.hostname,
                                    'port': cam.port ? cam.port.toString() : '',
                                    'urn': cam.urn ? cam.urn : mac,
                                    'channel': -1,
                                }
                            });
                    }
                    else
                    {
                        this.updateLog('Discovery (' + cam.hostname + '): Invalid service URI', 0);
                    }
                }
                catch (err)
                {
                    this.updateLog('Discovery catch error: ' + err.message + '\n' + err.message, 0);
                }
            });

            onvif.Discovery.on('error', (msg, xml) =>
            {
                this.updateLog('Discovery on error: ' + this.varToString(msg), 0);
                if (xml)
                {
                    this.updateLog('xml: ' + this.varToString(xml), 3);
                }
            });
        }

        // Start the discovery process running
        onvif.Discovery.probe(
            {
                'resolve': false
            });

        // Allow time for the process to finish
        await new Promise(resolve => this.homey.setTimeout(resolve, 9000));

        // Add in a manual option

        this.updateLog('====  Discovery Finished  ====');
        let devices = this.discoveredDevices;

        this.discoveredDevices = [];
        return devices;
    }

    async connectCamera(hostname, port, username, password)
    {
        this.updateLog('--------------------------');
        this.updateLog('Connect to Camera ' + hostname + ':' + port + ' - ' + username);

        const camObj = new Cam(
            {
                homeyApp: this.homey,
                hostname: hostname,
                username: username,
                password: password,
                port: parseInt(port),
                timeout: 15000,
                autoconnect: false,
            });

        // Use Promisify that was added to Node v8

        const promiseGetSystemDateAndTime = promisify(camObj.getSystemDateAndTime).bind(camObj);
        const promiseGetServices = promisify(camObj.getServices).bind(camObj);
        const promiseGetCapabilities = promisify(camObj.getCapabilities).bind(camObj);
        const promiseGetDeviceInformation = promisify(camObj.getDeviceInformation).bind(camObj);
        const promiseGetProfiles = promisify(camObj.getProfiles).bind(camObj);
        const promiseGetVideoSources = promisify(camObj.getVideoSources).bind(camObj);

        // Use Promisify to convert ONVIF Library calls into Promises.
        // Date & Time must work before anything else
        await promiseGetSystemDateAndTime();

        // Services can live without
        let gotServices = null;
        try
        {
            gotServices = await promiseGetServices();
        }
        catch (err)
        {
            this.updateLog('Error getting services: ' + err.message, 0);
        }

        // Must have capabilities
        let gotCapabilities = await promiseGetCapabilities();

        // Must have device information
        let gotInfo = await promiseGetDeviceInformation();

        // Profiles are optional
        let gotProfiles = [];
        let gotActiveSources = [];
        try
        {
            gotProfiles = await promiseGetProfiles();
        }
        catch (err)
        {
            this.updateLog('Error getting profiles: ' + err.message, 0);
        }

        // Video sources are optional
        try
        {
            await promiseGetVideoSources();
            gotActiveSources = camObj.getActiveSources();
        }
        catch (err)
        {
            this.updateLog('Error getting video sources: ' + err.message, 0);
        }

        return (camObj);
    }

    async checkCameras()
    {
        do
        {
            await new Promise(resolve => this.homey.setTimeout(resolve, 10000));

            const driver = this.homey.drivers.getDriver('camera');
            if (driver)
            {
                let devices = driver.getDevices();
                for (let i = 0; i < devices.length; i++)
                {
                    let device = devices[i];
                    try
                    {
                        await device.checkCamera();
                    }
                    catch (err)
                    {
                        this.updateLog('checkCameras' + err.message, 0);
                    }
                }
            }
        }
        // eslint-disable-next-line no-constant-condition
        while (true);
    }

    async unregisterCameras()
    {
        const driver = this.homey.drivers.getDriver('camera');
        if (driver)
        {
            let devices = driver.getDevices();
            for (let i = 0; i < devices.length; i++)
            {
                let device = devices[i];
                try
                {
                    await device.logout();
                }
                catch (err)
                {
                    this.updateLog('unregisterCameras' + err.message, 0);
                }
            }
        }
    }

    async getHostName(camObj)
    {
        const promiseGetHostname = promisify(camObj.getHostname).bind(camObj);
        return promiseGetHostname();
    }

    async getDateAndTime(camObj)
    {
        const promiseGetSystemDateAndTime = promisify(camObj.getSystemDateAndTime).bind(camObj);
        return promiseGetSystemDateAndTime();
    }

    async getDeviceInformation(camObj)
    {
        const promiseGetDeviceInformation = promisify(camObj.getDeviceInformation).bind(camObj);
        return promiseGetDeviceInformation();
    }

    async getCapabilities(camObj)
    {
        const promiseGetCapabilities = promisify(camObj.getCapabilities).bind(camObj);
        return promiseGetCapabilities();
    }

    async getServices(camObj)
    {
        const promiseGetServices = promisify(camObj.getServices).bind(camObj);
        return promiseGetServices();
    }

    async getServiceCapabilities(camObj)
    {
        const promiseGetServiceCapabilities = promisify(camObj.getServiceCapabilities).bind(camObj);
        return promiseGetServiceCapabilities();
    }

    async getSnapshotURL(camObj)
    {
        const promiseGetSnapshotUri = promisify(camObj.getSnapshotUri).bind(camObj);
        return promiseGetSnapshotUri();
    }

    async hasEventTopics(camObj)
    {
        const promiseGetSnapshotUri = promisify(camObj.getEventProperties).bind(camObj);
        const data = await promiseGetSnapshotUri();
        let supportedEvents = [];
        // Display the available Topics
        let parseNode = (node, topicPath, nodeName) =>
        {
            // loop over all the child nodes in this node
            for (const child in node)
            {
                if (child == '$')
                {
                    continue;
                }
                else if (child == 'messageDescription')
                {
                    // we have found the details that go with an event
                    supportedEvents.push(nodeName.toUpperCase());
                    return;
                }
                else
                {
                    // descend into the child node, looking for the messageDescription
                    parseNode(node[child], topicPath + '/' + child, child);
                }
            }
        };
        parseNode(data.topicSet, '', '');
        return (supportedEvents);
    }

    async subscribeToCamPushEvents(Device)
    {
        return new Promise((resolve, reject) =>
        {

            this.updateLog('App.subscribeToCamPushEvents: ' + Device.name);

            let unsubscribeRef = null;
            let pushEvent = this.pushEvents.find(element => element.devices.length > 0 && (element.devices[0].cam.hostname) === (Device.cam.hostname));
            if (pushEvent)
            {
                this.updateLog('App.subscribeToCamPushEvents: Found entry for ' + Device.cam.hostname);
                // An event is already registered for this IP address
                this.homey.clearTimeout(pushEvent.eventSubscriptionRenewTimerId);
                unsubscribeRef = pushEvent.unsubscribeRef;
                pushEvent.eventSubscriptionRenewTimerId = null;

                // see if this device is registered
                if (!pushEvent.devices.find(element => element.id == Device.id))
                {
                    this.updateLog('App.subscribeToCamPushEvents: Adding device ' + Device.name + ' to the queue');
                    pushEvent.devices.push(Device);
                }
            }
            else
            {
                this.updateLog('App.subscribeToCamPushEvents: Registering ' + Device.cam.hostname);
                pushEvent = {
                    'devices': [],
                    'refreshTime': 0,
                    'unsubscribeRef': unsubscribeRef,
                    'eventSubscriptionRenewTimerId': null
                };
                pushEvent.devices.push(Device);
                this.pushEvents.push(pushEvent);
            }

            if (unsubscribeRef)
            {
                this.updateLog('Renew previous events: ' + unsubscribeRef);
                Device.cam.RenewPushEventSubscription(unsubscribeRef, (err, info, xml) =>
                {
                    if (err)
                    {
                        this.updateLog('Renew subscription err (' + Device.name + '): ' + this.varToString(err), 0);
                        console.log(err);
                        // Refresh was probably too late so subscribe again
                        pushEvent.unsubscribeRef = null;
                        setImmediate(() =>
                        {
                            this.updateLog('Resubscribing');
                            this.subscribeToCamPushEvents(Device).catch(this.err);
                        });
                        resolve(true);
                        return;
                    }
                    else
                    {
                        this.updateLog('Renew subscription response (' + Device.name + '): ' + Device.cam.hostname + '\r\ninfo: ' + this.varToString(info));
                        let startTime = info[0].renewResponse[0].currentTime[0];
                        let endTime = info[0].renewResponse[0].terminationTime[0];
                        let d1 = new Date(startTime);
                        let d2 = new Date(endTime);
                        let refreshTime = ((d2.valueOf() - d1.valueOf()));

                        this.updateLog('Push renew every (' + Device.name + '): ' + (refreshTime / 1000), 1);
                        refreshTime -= 5000;
                        if (refreshTime < 0)
                        {
                            this.unsubscribe(Device).catch(this.err);
                        }

                        if (refreshTime < 3000)
                        {
                            refreshTime = 3000;
                        }

                        pushEvent.refreshTime = refreshTime;
                        pushEvent.unsubscribeRef = unsubscribeRef;
                        pushEvent.eventSubscriptionRenewTimerId = this.homey.setTimeout(() =>
                        {
                            this.updateLog('Renewing subscription');
                            this.subscribeToCamPushEvents(Device).catch(this.err);
                        }, refreshTime);
                        resolve(true);
                        return;
                    }
                });
            }
            else
            {
                // const url = "http://" + this.homeyIP + ":" + this.pushServerPort + "/onvif/events?deviceId=" + Device.cam.hostname;
                const hostPath = Device.cam.hostname;

                const url = 'http://' + this.homeyIP + ':' + this.pushServerPort + '/onvif/events/' + hostPath;
                this.updateLog('Setting up Push events (' + Device.name + ') on: ' + url);
                Device.cam.SubscribeToPushEvents(url, (err, info, xml) =>
                {
                    if (err)
                    {
                        this.updateLog('Subscribe err (' + Device.name + '): ' + err, 0);
                        reject(err);
                        return;
                    }
                    else
                    {

                        this.updateLog('Subscribe response (' + Device.name + '): ' + Device.cam.hostname + ' - Info: ' + this.varToString(info));
                        unsubscribeRef = info[0].subscribeResponse[0].subscriptionReference[0].address[0];

                        let startTime = info[0].subscribeResponse[0].currentTime[0];
                        let endTime = info[0].subscribeResponse[0].terminationTime[0];
                        let d1 = new Date(startTime);
                        let d2 = new Date(endTime);
                        let refreshTime = ((d2.valueOf() - d1.valueOf()));

                        this.updateLog('Push renew every (' + Device.name + '): ' + (refreshTime / 1000) + 's  @ ' + unsubscribeRef, 1);
                        refreshTime -= 5000;
                        if (refreshTime < 0)
                        {
                            this.unsubscribe(Device).catch(this.err);
                        }

                        if (refreshTime < 3000)
                        {
                            refreshTime += 3000;
                        }

                        pushEvent.refreshTime = refreshTime;
                        pushEvent.unsubscribeRef = unsubscribeRef;
                        pushEvent.eventSubscriptionRenewTimerId = this.homey.setTimeout(() =>
                        {
                            this.updateLog('Renewing subscription');
                            this.subscribeToCamPushEvents(Device).catch(this.err);
                        }, refreshTime);
                        resolve(true);
                        return;
                    }
                });
            }
        });
    }

    async unsubscribe(Device)
    {
        return new Promise((resolve, reject) =>
        {
            if (!Device.cam || !this.pushEvents)
            {
                resolve(null);
                return;
            }
            this.updateLog('App.unsubscribe: ' + Device.name);
            let deviceIdx = -1;
            let pushEvent = null;
            let pushEventIdx = this.pushEvents.findIndex(element => (element.devices[0] && Device.cam && ((element.devices[0].cam.hostname) === (Device.cam.hostname))));
            console.log('pushEvent Idx = ', pushEventIdx);
            if (pushEventIdx >= 0)
            {
                this.updateLog('App.unsubscribe: Found entry for ' + Device.cam.hostname);
                pushEvent = this.pushEvents[pushEventIdx];
                if (!pushEvent || !pushEvent.devices)
                {
                    resolve(null);
                    return;
                }

                // see if this device is registered
                deviceIdx = pushEvent.devices.findIndex(element => element.id == Device.id);
                if (deviceIdx < 0)
                {
                    // Not registered so do nothing
                    this.updateLog('App.unsubscribe: No Push entry for device: ' + Device.cam.hostname);
                    resolve(null);
                    return;
                }
            }
            else
            {
                this.updateLog('App.unsubscribe: No Push entry for host: ' + Device.cam.hostname);
                Device.cam.removeAllListeners('event');
                resolve(null);
                return;
            }

            if (pushEvent)
            {
                // Remove this device reference
                this.updateLog('App.unsubscribe: Unregister entry for ' + Device.cam.hostname);
                pushEvent.devices.splice(deviceIdx, 1);

                if ((pushEvent.devices.length == 0) && pushEvent.unsubscribeRef)
                {
                    // No devices left so unregister the event
                    this.homey.clearTimeout(pushEvent.eventSubscriptionRenewTimerId);
                    this.updateLog('Unsubscribe push event (' + Device.cam.hostname + '): ' + pushEvent.unsubscribeRef, 1);
                    const hostPath = Device.cam.hostname;
                    Device.cam.UnsubscribePushEventSubscription(pushEvent.unsubscribeRef, (err, info, xml) =>
                    {
                        if (err)
                        {
                            this.updateLog('Push unsubscribe error (' + hostPath + '): ' + this.varToString(err.message), 0);
                            reject(err);
                            return;
                        }
                        else
                        {
                            this.updateLog('Push unsubscribe response (' + hostPath + '): ' + this.varToString(info), 2);
                        }
                        resolve(null);
                        return;
                });

                    Device.cam.removeAllListeners('event');

                    // remove the push event from the list
                    this.pushEvents.splice(pushEventIdx, 1);
                }
                else
                {
                    if (pushEvent.devices.length == 0)
                    {
                        // remove the push event from the list
                        this.pushEvents.splice(pushEventIdx, 1);
                    }
                    this.updateLog('App.unsubscribe: Keep subscription as devices are still registered');

                    Device.cam.removeAllListeners('event');
                    resolve(null);
                    return;
                }
            }
        });
    }

    hasPullSupport(capabilities, id)
    {
        if (capabilities && capabilities.events && capabilities.events.WSPullPointSupport && capabilities.events.WSPullPointSupport == true)
        {
            this.updateLog('Camera (' + id + ') supports PullPoint');
            return true;
        }

        this.updateLog('Camera (' + id + ') does NOT support PullPoint Events', 3);
        return false;
    }

    hasBaseEvents(services, id)
    {
        if (services && services.Capabilities && ((services.Capabilities.MaxNotificationProducers > 0) || (services.Capabilities.WSSubscriptionPolicySupport === true)))
        {
            this.updateLog('Camera (' + id + ') supports Push Events');
            return true;
        }

        this.updateLog('This camera (' + id + ') does NOT support Push Events', 0);
        return false;
    }

    stripNamespaces(topic)
    {
        // example input :-   tns1:MediaControl/tnsavg:ConfigurationUpdateAudioEncCfg
        // Split on '/'
        // For each part, remove any namespace
        // Recombine parts that were split with '/'
        let output = '';
        if (topic)
        {
            let parts = topic.split('/');
            for (let index = 0; index < parts.length; index++)
            {
                let stringNoNamespace = parts[index].split(':').pop(); // split on :, then return the last item in the array
                if (output.length == 0)
                {
                    output += stringNoNamespace;
                }
                else
                {
                    output += '/' + stringNoNamespace;
                }
            }
        }
        return output;
    }

    getUserDataPath(filename)
    {
        return path.join('/userdata', filename);
    }

    varToString(source)
    {
        try
        {
            if (source === null)
            {
                return 'null';
            }
            if (source === undefined)
            {
                return 'undefined';
            }
            if (source instanceof Error)
            {
                var stack = source.stack.replace(/\\n/g, '\n');
                stack = stack.replace(/\n/g, '\n         ');
                return `${source.message}\n      ${stack}`;
            }
            if (typeof(source) === 'object')
            {
                const getCircularReplacer = (homey) =>
                {
                    const seen = new WeakSet();
                    return (key, value) =>
                    {
                        if (typeof value === 'object' && value !== null)
                        {
                            if (seen.has(value) || value === homey)
                            {
                                return '';
                            }
                            seen.add(value);
                        }
                        return value;
                    };
                };

                return JSON.stringify(source, getCircularReplacer(this.homey), '\t');
            }
            if (typeof(source) === 'string')
            {
                return source;
            }
        }
        catch (err)
        {
            this.homey.app.updateLog(`VarToString Error: ${err.message}`, 0);
        }

        return source.toString();
    }

    updateLog(newMessage, logLevel = 2, insertBlankLine = false)
    {
        if (logLevel > this.logLevel)
        {
            return;
        }

        this.log(newMessage);

        let oldText = this.homey.settings.get('diagLog');
        if (oldText && oldText.length > 200000)
        {
            // Remove the first 1000 characters.
            oldText = oldText.substring(1000);
            let n = oldText.indexOf('\n');
            if (n >= 0)
            {
                // Remove up to and including the first \n so the log starts on a whole line
                oldText = oldText.substring(n + 1);
            }
        }

        const nowTime = new Date(Date.now());

        if (!oldText || (oldText.length == 0) || (this.logDay !== nowTime.getDate()))
        {
            this.logDay = nowTime.getDate();
            oldText = 'Log ID: ';
            oldText += nowTime.toJSON();
            oldText += '\r\n';
            oldText += 'App version ';
            oldText += this.homey.manifest.version;
            oldText += '\r\n\r\n';
            this.logLastTime = nowTime;
        }

        this.logLastTime = nowTime;

        if (insertBlankLine)
        {
            oldText += '\r\n';
        }

        oldText += (nowTime.getHours());
        oldText += ':';
        oldText += nowTime.getMinutes();
        oldText += ':';
        oldText += nowTime.getSeconds();
        oldText += '.';
        let milliSeconds = nowTime.getMilliseconds().toString();
        if (milliSeconds.length == 2)
        {
            oldText += '0';
        }
        else if (milliSeconds.length == 1)
        {
            oldText += '00';
        }
        oldText += milliSeconds;
        oldText += ': ';
        oldText += newMessage;
        oldText += '\r\n';
        this.homey.settings.set('diagLog', oldText);
    }

    async sendLog({email = ''})
    {
        let tries = 5;

        while (tries-- > 0)
        {
            try
            {
                this.updateLog('Sending log', 0);
                // create reusable transporter object using the default SMTP transport
                let transporter = nodemailer.createTransport(
                    {
                        host: Homey.env.MAIL_HOST, //Homey.env.MAIL_HOST,
                        port: 465,
                        ignoreTLS: false,
                        secure: true, // true for 465, false for other ports
                        auth:
                    {
                        user: Homey.env.MAIL_USER, // generated ethereal user
                        pass: Homey.env.MAIL_SECRET // generated ethereal password
                    },
                        tls:
                    {
                        // do not fail on invalid certs
                        rejectUnauthorized: false
                    }
                    });

                // send mail with defined transport object
                let info = await transporter.sendMail(
                    {
                        from: '"Homey User" <' + Homey.env.MAIL_USER + '>', // sender address
                        to: Homey.env.MAIL_RECIPIENT, // list of receivers
                        subject: 'ONVIF log (' + this.homeyHash + ' : ' + this.homey.manifest.version + ')', // Subject line
                        text: email + '\n' + this.homey.settings.get('diagLog') // plain text body
                    });

                this.updateLog('Message sent: ' + info.messageId);
                // Message sent: <b658f8ca-6296-ccf4-8306-87d57a0b4321@example.com>

                // Preview only available when sending through an Ethereal account
                console.log('Preview URL: ', nodemailer.getTestMessageUrl(info));
                return '';
            }
            catch (err)
            {
                this.updateLog('Send log error: ' + err.message, 0);
            }
        }
        this.updateLog('Send log FAILED', 0);
        throw (new Error('Send log FAILED'));
    }

    async triggerMotion(tokens)
	{
		this.motionTrigger.trigger(tokens).catch(this.err);
    }

    async getPTZStatus(camObj) {
        try {
            // Vérifier les capacités PTZ de la caméra
            const capabilities = await this.getCapabilities(camObj);
            if (!capabilities || !capabilities.PTZ) {
                this.updateLog('Cette caméra ne supporte pas le PTZ', 0);
                return false;
            }

            // Les préréglages sont gérés directement par la librairie ONVIF
            return true;
        } catch (err) {
            this.updateLog('Erreur lors de la vérification PTZ: ' + err.message, 0);
            return false;
        }
    }
}

module.exports = MyApp;