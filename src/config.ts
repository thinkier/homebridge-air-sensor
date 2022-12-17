import {AccessoryConfig} from "homebridge";

export interface Config extends AccessoryConfig {
    api_endpoint: string,
    timeout?: number,
    features?: {
        temperature?: boolean,
        humidity?: boolean,
        aqi?: boolean,
        pm10?: boolean,
        pm2_5?: boolean,
        voc?: boolean,
        co?: boolean,
        co_ppm?: boolean,
        co2?: boolean
        co2_ppm?: boolean,
    }
}