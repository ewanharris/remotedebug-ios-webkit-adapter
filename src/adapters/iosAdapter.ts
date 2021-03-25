//
// Copyright (C) Microsoft. All rights reserved.
//

import got from 'got';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as WebSocket from 'ws';
import * as which from 'which'
import { exec, execFile } from 'child-process-promise';
import { Logger, debug } from '../logger';
import { Adapter } from './adapter';
import { Target } from '../protocols/target';
import { AdapterCollection } from './adapterCollection';
import { ITarget, IIOSDeviceTarget, IIOSProxySettings } from './adapterInterfaces';
import { IOSProtocol } from '../protocols/ios/ios';
import { IOS8Protocol } from '../protocols/ios/ios8';
import { IOS9Protocol } from '../protocols/ios/ios9';
import { IOS12Protocol } from '../protocols/ios/ios12';
import { IOS13Protocol } from '../protocols/ios/ios13';

export class IOSAdapter extends AdapterCollection {
    private _proxySettings: IIOSProxySettings;
    private _protocolMap: Map<Target, IOSProtocol>;
    private _simulatorVersionMap: Map<string, string>;

    constructor(id: string, socket: string, proxySettings: IIOSProxySettings) {
        super(id, socket, {
            port: proxySettings.proxyPort,
            proxyExePath: proxySettings.proxyPath,
            proxyExeArgs: proxySettings.proxyArgs
        });

        this._proxySettings = proxySettings;
        this._protocolMap = new Map<Target, IOSProtocol>();
        this._simulatorVersionMap = new Map<string, string>();
    }

    public async getTargets(): Promise<ITarget[]> {
        debug(`iOSAdapter.getTargets`);
        const devices: IIOSDeviceTarget[] = [];
        try {
            const { body } = await got(this._url);
            const rawDevices: IIOSDeviceTarget[] = JSON.parse(body);

            for (const d of rawDevices) {
                if (d.deviceId === 'SIMULATOR') {
                    // iwdb doesn't report a sim udid so we use the one passed in by the user. This only works because we only support a single simulator, if multiple sims were supported then it wouldn't work
                    d.version = await this.getSimulatorVersion(this._proxySettings.simUdid);
                } else if (d.deviceOSVersion) {
                    d.version = d.deviceOSVersion;
                } else {
                    debug(`error.iosAdapter.getTargets.getDeviceVersion.failed.fallback, device=${d}. Please update ios-webkit-debug-proxy to version 1.8.5`);
                    d.version = '9.3.0';
                }

                const adapterId = `${this._id}_${d.deviceId}`;
                if (!this._adapters.has(adapterId)) {
                    const parts = d.url.split(':');
                    if (parts.length > 1) {
                        // Get the port that the ios proxy exe is forwarding for this device
                        const port = parseInt(parts[1], 10);

                        // Create a new adapter for this device and add it to our list
                        const adapter = new Adapter(adapterId, this._proxyUrl, { port: port });
                        adapter.start();
                        adapter.on('socketClosed', (id) => {
                            this.emit('socketClosed', id);
                        });
                        this._adapters.set(adapterId, adapter);
                    }
                }
                devices.push(d);
            }
        } catch (error) {
            // todo
        }

        return super.getTargets(devices);
    }

    public connectTo(url: string, wsFrom: WebSocket): Target {
        const target = super.connectTo(url, wsFrom);

        if (!target) {
            throw new Error(`Target not found for ${url}`);
        }

        if (!this._protocolMap.has(target)) {
            const version = (target.data.metadata as IIOSDeviceTarget).version;
            const protocol = this.getProtocolFor(version, target);
            this._protocolMap.set(target, protocol);
        }
        return target;
    }

    public static async getProxySettings(args: IIOSProxySettings & { unixPort: string }): Promise<IIOSProxySettings> {
        debug(`iOSAdapter.getProxySettings`);
        let settings: IIOSProxySettings = null;

        // Check that the proxy exists
        const proxyPath = await IOSAdapter.getProxyPath();

        // Start with remote debugging enabled
        // Use default parameters for the ios_webkit_debug_proxy executable
        const proxyPort = args.proxyPort;
        const proxyArgs = [
            '--no-frontend',
            '--config=null:' + proxyPort + ',:' + (proxyPort + 1) + '-' + (proxyPort + 101)
        ];
        if (args.unixPort) {
            proxyArgs.push(
                `-s`, `unix:${args.unixPort}`
            )
        }

        settings = {
            proxyPath: proxyPath,
            proxyPort: proxyPort,
            proxyArgs: proxyArgs,
            simUdid: args.simUdid
        };

        return settings;
    }

    public static getSimulatorUnixSocket(simUDID: string): Promise<string|null> {
        debug(`iOSAdapter.getSimulatorUnixSocket`);
        return new Promise(async (resolve, reject) => {
            try {
                const { stdout } = await exec('lsof -aUc launchd_sim');
                for (const output of stdout.split('com\.apple\.CoreSimulator\.SimDevice.')) {
                    if (!output.includes(simUDID)) {
                        continue;
                    }

                    const match = /\s+(\S+com\.apple\.webinspectord_sim\.socket)/.exec(output);

                    if (!match) {
                        return resolve(null);
                    }

                    return resolve(match[1]);
                }
            } catch (error) {
                return reject(error);
            }
        });
    }

    private static getProxyPath(): Promise<string> {
        debug(`iOSAdapter.getProxyPath`);
        return new Promise((resolve, reject) => {
            if (os.platform() === 'win32') {
                const proxy = process.env.SCOOP ?
                path.resolve(__dirname, process.env.SCOOP + '/apps/ios-webkit-debug-proxy/current/ios_webkit_debug_proxy.exe') :
                path.resolve(__dirname, process.env.USERPROFILE + '/scoop/apps/ios-webkit-debug-proxy/current/ios_webkit_debug_proxy.exe');
                try {
                    fs.statSync(proxy);
                    resolve(proxy);
                } catch (err) {
                    let message = `ios_webkit_debug_proxy.exe not found. Please install 'scoop install ios-webkit-debug-proxy'`;
                    reject(message);
                }
            } else if (os.platform() === 'darwin' || os.platform() === 'linux') {
                which('ios_webkit_debug_proxy', function (err, resolvedPath) {
                    if (err) {
                        reject('ios_webkit_debug_proxy not found. Please install ios_webkit_debug_proxy (https://github.com/google/ios-webkit-debug-proxy)');
                    } else {
                        resolve(resolvedPath);
                    }
                });
            }
        });
    }

    private getProtocolFor(version: string, target: Target): IOSProtocol {
        debug(`iOSAdapter.getProtocolFor`);
        const parts = version.split('.');
        if (parts.length > 0) {
            const major = parseInt(parts[0], 10);
            const minor = parseInt(parts[1], 10);

            if (major <= 8) {
                return new IOS8Protocol(target);
            }

            if (major > 13 || major >= 13 && minor >= 4) {
                return new IOS13Protocol(target);
            }

            if (target.data.metadata.deviceId !== 'SIMULATOR' && major === 12 && minor === 2) {
                return new IOS12Protocol(target);
            }
        }

        return new IOS9Protocol(target);
    }

    private async getSimulatorVersion(udid: string): Promise<string> {

        if (this._simulatorVersionMap.has(udid)) {
            return this._simulatorVersionMap.get(udid);
        }

        let iosVersion;
        try {
            const { stdout } = await exec('xcrun simctl list --json');
            const { devices, runtimes } = JSON.parse(stdout);
            for (const [type, vals] of Object.entries(devices)) {
                if (!type.includes('SimRuntime.iOS')) {
                    continue;
                }

                if (!Array.isArray(vals)) {
                    continue;
                }

                for (const val of vals) {
                    if (val.udid === udid) {
                        const runtime = runtimes.find(rt => rt.identifier === type);
                        iosVersion = runtime.version;
                        break;
                    }
                }

                if (iosVersion ) {
                    break;
                }
            }
        } catch (error) {
            iosVersion = '9.3.0';
        }

        this._simulatorVersionMap.set(udid, iosVersion);

        return iosVersion;
    }
}
