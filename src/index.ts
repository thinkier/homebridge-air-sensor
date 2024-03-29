import {
    AccessoryPlugin,
    API, Characteristic,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    HAP,
    HAPStatus,
    Logging,
    Service
} from "homebridge";
import {Config} from "./config";
import dgram from "node:dgram";
import fetch from "node-fetch";
import http from "node:http";

interface SensorReport {
    temperature?: number,
    humidity?: number,
    air_quality?: number,
    pm10?: number;
    pm2_5?: number;
    voc_ppm?: number,
    co_detected?: boolean
    co_ppm?: number,
    co2_detected?: boolean
    co2_ppm?: number,
    readings?: Record<string, number | string | boolean>
}

let hap: HAP;

export = (api: API) => {
    hap = api.hap;
    api.registerAccessory("AirQualitySensor", AirQualitySensor);
};

class AirQualitySensor implements AccessoryPlugin {
    private readonly name: string;
    private readonly informationService: Service;
    private readonly timeout: number;

    private readonly tempsService: Service | undefined;
    private readonly humidityService: Service | undefined;
    private readonly airQualityService: Service | undefined;
    private readonly coService: Service | undefined;
    private readonly co2Service: Service | undefined;

    private http_server: http.Server = undefined;
    private udp_socket: dgram.Socket = undefined;
    private last_updated = 0;
    private data: SensorReport = {};

    constructor(private readonly log: Logging, private readonly config: Config, api: API) {
        this.name = config.name;

        this.informationService = new hap.Service.AccessoryInformation()
            .setCharacteristic(hap.Characteristic.Manufacturer, "ACME Pty Ltd");

        this.timeout = (config.timeout ?? 30) * 1e3;

        log.info(`Creating sensor with the following extra features: ${JSON.stringify(config.features)}`)

        if (config.features.temperature !== false) {
            this.tempsService = new hap.Service.TemperatureSensor(this.name);
            this.tempsService.getCharacteristic(hap.Characteristic.CurrentTemperature)
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    this.callback(callback, this.data?.temperature);
                })
        }

        if (config.features.humidity !== false) {
            this.humidityService = new hap.Service.HumiditySensor(this.name);
            this.humidityService.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity)
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    this.callback(callback, this.data?.humidity);
                })
        }

        if (config.features?.aqi) {
            this.airQualityService = new hap.Service.AirQualitySensor(this.name);
            this.airQualityService.getCharacteristic(hap.Characteristic.AirQuality)
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    this.callback(callback, this.data?.air_quality);
                });

            if (config.features?.pm10) {
                this.airQualityService.getCharacteristic(hap.Characteristic.PM10Density)
                    .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                        this.callback(callback, this.data?.pm10);
                    })
            }

            if (config.features?.pm2_5) {
                this.airQualityService.getCharacteristic(hap.Characteristic.PM2_5Density)
                    .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                        this.callback(callback, this.data?.pm2_5);
                    })
            }

            if (config.features?.voc) {
                this.airQualityService.getCharacteristic(hap.Characteristic.VOCDensity)
                    .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                        this.callback(callback, this.data?.voc_ppm);
                    })
            }
        }

        if (config.features?.co) {
            this.coService = new hap.Service.CarbonMonoxideSensor(this.name);
            this.coService.getCharacteristic(hap.Characteristic.CarbonMonoxideDetected)
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    this.callback(callback, this.co_detected())
                })
            if (config.features.co_ppm) {
                this.coService.getCharacteristic(hap.Characteristic.CarbonMonoxideLevel)
                    .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                        this.callback(callback, this.data?.co_ppm)
                    })
            }
        }

        if (config.features?.co2) {
            this.co2Service = new hap.Service.CarbonDioxideSensor(this.name);
            this.co2Service.getCharacteristic(hap.Characteristic.CarbonDioxideDetected)
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    this.callback(callback, this.co2_detected())
                })
            if (config.features.co2_ppm) {
                this.co2Service.getCharacteristic(hap.Characteristic.CarbonDioxideLevel)
                    .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                        this.callback(callback, this.data?.co2_ppm)
                    })
            }
        }

        setInterval(async () => {
            if (await this.retrieveSensorData()) {
                this.normalizeData();
                this.updateCharacteristics(config);
            }
        }, 5e3);

        log.info("Sensor finished initializing!");
    }

    callback = (cb: CharacteristicGetCallback, value: any) => {
        if (Date.now() - this.last_updated > this.timeout) {
            cb(HAPStatus.OPERATION_TIMED_OUT)
        } else if (value === undefined) {
            cb(HAPStatus.RESOURCE_DOES_NOT_EXIST);
        } else {
            cb(HAPStatus.SUCCESS, value);
        }
    }

    retrieveSensorData = async () => {
        try {
            if (!this.config.api_endpoint) {
                this.log.error("API Endpoint of the sensor is not defined!")
            }
            const url = new URL(this.config.api_endpoint);
            if (url.protocol === "http:") {
                if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
                    if (this.http_server === undefined) {
                        this.http_server = http.createServer((req, res) => {
                            if (["POST", "PUT"].indexOf(req.method) < 0 || ["application/json", "text/json"].indexOf(req.headers["content-type"]) < 0) {
                                res.statusCode = 400;
                                res.end("Only accepts JSON POST/PUT");
                                this.log.error(`Bad request from ${req.socket.remoteAddress}:${req.socket.remotePort}`)
                                return;
                            }

                            let buf = "";
                            req.setEncoding("utf8");
                            req.on("data", _ => {
                                buf += req.read();
                            })
                            this.log.info(buf);
                            req.on("end", _ => {
                                this.data = JSON.parse(buf);
                                this.last_updated = Date.now();
                                this.log.info(`Accepted new data from ${req.socket.remoteAddress}:${req.socket.remotePort}`)
                            })
                        });
                        this.http_server.listen(Number.parseInt(url.port, 10));
                        this.log.info("Listening to HTTP accessory on", url.port)
                    }
                } else {
                    this.data = await fetch(this.config.api_endpoint)
                        .then(x => x.json()) as SensorReport;
                    this.last_updated = Date.now();
                }
            } else if (url.protocol === "udp:") {
                if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
                    if (this.udp_socket === undefined) {
                        this.udp_socket = dgram.createSocket("udp4", (msg, rinfo) => {
                            this.data = JSON.parse(msg.toString("utf8"));
                            this.last_updated = Date.now();
                            this.log.info(`Accepted new data from ${rinfo.address}:${rinfo.port}`)
                        });
                        this.udp_socket.bind(Number.parseInt(url.port, 10));
                        this.log.info("Listening to UDP accessory on", url.port)
                    }
                } else {
                    this.data = await new Promise((res, rej) => {
                        let sock = dgram.createSocket("udp4", (msg, rinfo) => {
                            if (rinfo.address === url.hostname) {
                                res(JSON.parse(msg.toString("utf8")));
                                sock.close();
                            }
                        });
                        sock.bind();
                        sock.send("", Number.parseInt(url.port, 10), url.hostname);
                    });
                    this.last_updated = Date.now();
                }
            } else {
                this.log.error("Unknown protocol", url.protocol, "for sensor", this.name);
                return false;
            }

            return true;
        } catch (ex) {
            this.log.warn(`Failed to retrieve sensor data: ${ex}`);
        }

        return false;
    }

    normalizeData = () => {
        if (this.data && "readings" in this.data && typeof this.data.readings === "object") {
            this.data = {...this.data, ...this.data.readings};
            delete this.data.readings;

            if (this.config.features.aqi && this.config.features.pm10 && typeof this.data.air_quality !== "number") {
                this.data.air_quality = pm10ToAqi(this.data.pm10);
            }
        }
    }

    getServices(): Service[] {
        return [
            this.informationService,
            this.tempsService,
            this.humidityService,
            this.airQualityService,
            this.coService,
            this.co2Service
        ].filter(x => x !== undefined);
    }

    private updateCharacteristics(config: Config) {
        if (config.features.temperature) {
            if (this.data.temperature) {
                this.tempsService.updateCharacteristic(hap.Characteristic.CurrentTemperature, this.data.temperature);
            }
        }
        if (config.features.humidity) {
            if (this.data.humidity) {
                this.humidityService.updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, this.data.humidity);
            }
        }
        if (config.features.aqi) {
            if (this.data.air_quality) {
                this.airQualityService.updateCharacteristic(hap.Characteristic.AirQuality, this.data.air_quality);
            }

            if (config.features.pm10 && typeof this.data.pm10 === "number") {
                this.airQualityService.updateCharacteristic(hap.Characteristic.PM10Density, this.data.pm10);
            }

            if (config.features.pm2_5 && typeof this.data.pm2_5 === "number") {
                this.airQualityService.updateCharacteristic(hap.Characteristic.PM2_5Density, this.data.pm2_5);
            }

            if (config.features.voc && typeof this.data.voc_ppm === "number") {
                this.airQualityService.updateCharacteristic(hap.Characteristic.VOCDensity, this.data.voc_ppm);
            }
        }
        if (config.features.co) {
            let co_detected = this.co_detected();
            if (co_detected !== undefined) {
                this.coService.updateCharacteristic(hap.Characteristic.CarbonMonoxideDetected, co_detected);
            }
            if (this.data.co_ppm) {
                this.coService.updateCharacteristic(hap.Characteristic.CarbonMonoxideLevel, this.data.co_ppm);
            }
        }
        if (config.features.co2) {
            let co2_detected = this.co2_detected();
            if (co2_detected !== undefined) {
                this.co2Service.updateCharacteristic(hap.Characteristic.CarbonDioxideDetected, co2_detected);
            }
            if (this.data.co2_ppm) {
                this.co2Service.updateCharacteristic(hap.Characteristic.CarbonDioxideLevel, this.data.co2_ppm);
            }
        }
    }

    co_detected = () => {
        if (this.data?.co_detected !== undefined) {
            return this.data?.co_detected ?
                hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL :
                hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL
        }

        if (!("co_ppm" in this.data)) {
            return undefined;
        }

        return this.data?.co_ppm > 2 ?
            hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL :
            hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL
    }

    co2_detected = () => {
        if (this.data?.co2_detected !== undefined) {
            return this.data?.co2_detected ?
                hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL :
                hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL
        }

        if (!("co2_ppm" in this.data)) {
            return undefined;
        }

        return this.data?.co2_ppm > 2000 ?
            hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL :
            hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL
    }
}

// EU CAQI: https://en.wikipedia.org/wiki/Air_quality_index#CAQI
function pm10ToAqi(pm10_ugm: number) {
    if (pm10_ugm <= 25) {
        return hap.Characteristic.AirQuality.EXCELLENT;
    } else if (pm10_ugm <= 50) {
        return hap.Characteristic.AirQuality.GOOD;
    } else if (pm10_ugm <= 75) {
        return hap.Characteristic.AirQuality.FAIR;
    } else if (pm10_ugm <= 100) {
        return hap.Characteristic.AirQuality.INFERIOR;
    }
    return hap.Characteristic.AirQuality.POOR;
}
