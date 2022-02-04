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
import fetch from "node-fetch";

interface SensorReport {
    air_quality: number,
    gas_resistance: number,
    temp: number,
    humidity: number,
    pressure: number
}

let hap: HAP;

export = (api: API) => {
    hap = api.hap;
    api.registerAccessory("AirQualitySensor", AirQualitySensor);
};

class AirQualitySensor implements AccessoryPlugin {
    private readonly name: string;
    private readonly informationService: Service;

    private readonly tempsService: Service;
    private readonly humidityService: Service;
    private readonly airQualityService: Service;

    private lastFetch: number = 0;
    private data: SensorReport | undefined;

    constructor(private readonly log: Logging, private readonly config: Config, api: API) {
        this.name = config.name;

        this.informationService = new hap.Service.AccessoryInformation()
            .setCharacteristic(hap.Characteristic.Manufacturer, "ACME Pty Ltd")
            .setCharacteristic(hap.Characteristic.Model, "_");

        this.tempsService = new hap.Service.TemperatureSensor(this.name);
        this.tempsService.getCharacteristic(hap.Characteristic.CurrentTemperature)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(!this.data ? HAPStatus.OPERATION_TIMED_OUT : undefined,
                    this.data?.temp);
            })

        this.humidityService = new hap.Service.HumiditySensor(this.name);
        this.humidityService.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(!this.data ? HAPStatus.OPERATION_TIMED_OUT : undefined,
                    this.data?.humidity);
            })

        this.airQualityService = new hap.Service.AirQualitySensor(this.name);
        this.airQualityService.getCharacteristic(hap.Characteristic.AirQuality)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(!this.data ? HAPStatus.OPERATION_TIMED_OUT : undefined,
                    Math.round(this.data?.air_quality ?? 0));
            })

        setInterval(this.retrieveSensorData, 5e3);

        log.info("Sensor finished initializing!");
    }

    retrieveSensorData = async () => {
        try {
            if (!this.config.api_endpoint) {
                this.log.error("API Endpoint of the sensor is not defined!")
            }

            this.data = await fetch(this.config.api_endpoint)
                .then(x => x.json()) as SensorReport;
        } catch (ex) {
            this.log.error(`Failed to retrieve sensor data: ${ex}`);
        }
    }

    getServices(): Service[] {
        return [
            this.informationService,
            this.tempsService,
            this.humidityService,
            this.airQualityService
        ];
    }
}