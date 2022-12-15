import {AccessoryConfig} from "homebridge";

export interface Config extends AccessoryConfig {
    api_endpoint: string,
    timeout?: number,
    features?: {
        temperature?: boolean,
        humidity?: boolean,
        aqi?: boolean,
        voc?: boolean,
        co?: boolean,
        co_ppm?: boolean,
        co2?: boolean
        co2_ppm?: boolean,
    }
}