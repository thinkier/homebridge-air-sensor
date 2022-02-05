import {AccessoryConfig} from "homebridge";

export interface Config extends AccessoryConfig {
    api_endpoint: string,
    features?: {
        aqi?: boolean,
        voc?: boolean,
        co2?: boolean
    }
}