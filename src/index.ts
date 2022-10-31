import {
    AccessoryPlugin,
    API,
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

interface CachedData {
    co_ppm_peak?: number
    co2_ppm_peak?: number
}

interface SensorReport {
    temperature?: number,
    humidity?: number,
    air_quality?: number,
    voc_ppm?: number,
    co_ppm?: number,
    co2_ppm?: number,
}

let hap: HAP;

export = (api: API) => {
    hap = api.hap;
    api.registerAccessory("AirQualitySensor", AirQualitySensor);
};

class AirQualitySensor implements AccessoryPlugin {
    private readonly name: string;
    private readonly informationService: Service;

    private readonly tempsService: Service | undefined;
    private readonly humidityService: Service | undefined;
    private readonly airQualityService: Service | undefined;
    private readonly coService: Service | undefined;
    private readonly co2Service: Service | undefined;

    private data: SensorReport | undefined;
    private cache: CachedData = {};

    constructor(private readonly log: Logging, private readonly config: Config, api: API) {
        this.name = config.name;

        this.informationService = new hap.Service.AccessoryInformation()
            .setCharacteristic(hap.Characteristic.Manufacturer, "ACME Pty Ltd");

        log.info(`Creating sensor with the following extra features: ${JSON.stringify(config.features)}`)

        if (config.features.temperature !== false) {
            this.tempsService = new hap.Service.TemperatureSensor(this.name);
            this.tempsService.getCharacteristic(hap.Characteristic.CurrentTemperature)
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    callback(!this.data ? HAPStatus.OPERATION_TIMED_OUT : undefined,
                        this.data?.temperature);
                })
        }

        if (config.features.humidity !== false) {
            this.humidityService = new hap.Service.HumiditySensor(this.name);
            this.humidityService.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity)
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    callback(!this.data ? HAPStatus.OPERATION_TIMED_OUT : undefined,
                        this.data?.humidity);
                })
        }

        if (config.features?.aqi) {
            this.airQualityService = new hap.Service.AirQualitySensor(this.name);
            this.airQualityService.getCharacteristic(hap.Characteristic.AirQuality)
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    callback(!this.data ? HAPStatus.OPERATION_TIMED_OUT : undefined,
                        this.data?.air_quality);
                });
            if (config.features?.voc) {
                this.airQualityService.getCharacteristic(hap.Characteristic.VOCDensity)
                    .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                        callback(!this.data?.voc_ppm ? HAPStatus.RESOURCE_DOES_NOT_EXIST : undefined,
                            this.data?.voc_ppm);
                    })
            }
        }

        if (config.features?.co) {
            this.co2Service = new hap.Service.CarbonMonoxideSensor(this.name);
            this.co2Service.getCharacteristic(hap.Characteristic.CarbonMonoxideDetected)
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    callback(!this.data?.co_ppm ? HAPStatus.OPERATION_TIMED_OUT : undefined,
                        this.co_detected())
                })
            this.co2Service.getCharacteristic(hap.Characteristic.CarbonMonoxideLevel)
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    callback(!this.data?.co_ppm ? HAPStatus.OPERATION_TIMED_OUT : undefined,
                        this.data?.co_ppm)
                })
            this.co2Service.getCharacteristic(hap.Characteristic.CarbonMonoxidePeakLevel)
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    callback(!this.cache?.co_ppm_peak ? HAPStatus.OPERATION_TIMED_OUT : undefined,
                        this.cache?.co_ppm_peak)
                })
        }

        if (config.features?.co2) {
            this.co2Service = new hap.Service.CarbonDioxideSensor(this.name);
            this.co2Service.getCharacteristic(hap.Characteristic.CarbonDioxideDetected)
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    callback(!this.data?.co2_ppm ? HAPStatus.OPERATION_TIMED_OUT : undefined,
                        this.co2_detected())
                })
            this.co2Service.getCharacteristic(hap.Characteristic.CarbonDioxideLevel)
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    callback(!this.data?.co2_ppm ? HAPStatus.OPERATION_TIMED_OUT : undefined,
                        this.data?.co2_ppm)
                })
            this.co2Service.getCharacteristic(hap.Characteristic.CarbonDioxidePeakLevel)
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    callback(!this.cache?.co2_ppm_peak ? HAPStatus.OPERATION_TIMED_OUT : undefined,
                        this.cache?.co2_ppm_peak)
                })
        }

        setInterval(async () => {
            if (await this.retrieveSensorData()) {
                this.updateCharacteristics(config);
            }
        }, 5e3);

        log.info("Sensor finished initializing!");
    }

    retrieveSensorData = async () => {
        try {
            if (!this.config.api_endpoint) {
                this.log.error("API Endpoint of the sensor is not defined!")
            }
            const url = new URL(this.config.api_endpoint);
            if (url.protocol === "http") {
                this.data = await fetch(this.config.api_endpoint)
                    .then(x => x.json()) as SensorReport;
            } else if (url.protocol === "udp") {
                // TODO Implement UDP fetch
                this.data = await new Promise((res, rej) => {
                    let sock = dgram.createSocket("udp4", (msg, rinfo) => {
                        if (rinfo.address === url.host) {
                            res(JSON.parse(msg.toString("utf8")));
                            sock.close();
                        }
                    });
                    sock.bind();
                    sock.send("", Number.parseInt(url.port, 10), url.host);
                });
            }

            if ("co_ppm" in this.data && (!this.cache.co_ppm_peak || this.data.co_ppm > this.cache.co_ppm_peak)) {
                this.cache.co_ppm_peak = this.data.co_ppm
            }
            if ("co2_ppm" in this.data && (!this.cache.co2_ppm_peak || this.data.co2_ppm > this.cache.co2_ppm_peak)) {
                this.cache.co2_ppm_peak = this.data.co2_ppm
            }

            return true;
        } catch (ex) {
            this.log.warn(`Failed to retrieve sensor data: ${ex}`);
        }

        return false;
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
        if (this.data.temperature) {
            this.tempsService.updateCharacteristic(hap.Characteristic.CurrentTemperature, this.data.temperature);
        }
        if (this.data.humidity) {
            this.humidityService.updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, this.data.humidity);
        }
        if (config.features.aqi) {
            if (this.data.air_quality) {
                this.airQualityService.updateCharacteristic(hap.Characteristic.AirQuality, this.data.air_quality);
            }
            if (this.data.voc_ppm && config.features.voc) {
                this.airQualityService.updateCharacteristic(hap.Characteristic.VOCDensity, this.data.voc_ppm);
            }
        }
        if (config.features.co2) {
            if (this.data.co2_ppm) {
                this.co2Service.updateCharacteristic(hap.Characteristic.CarbonDioxideDetected, this.co2_detected());
                this.co2Service.updateCharacteristic(hap.Characteristic.CarbonDioxideLevel, this.data.co2_ppm);
                this.co2Service.updateCharacteristic(hap.Characteristic.CarbonDioxidePeakLevel, this.cache.co2_ppm_peak);
            }
        }
    }

    co_detected = () => {
        return this.data?.co2_ppm > 2 ?
            hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL :
            hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL
    }

    co2_detected = () => {
        return this.data?.co2_ppm > 1000 ?
            hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL :
            hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL
    }
}