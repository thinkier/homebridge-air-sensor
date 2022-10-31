import {AccessoryConfig} from "homebridge";

export interface Config extends AccessoryConfig {
    api_endpoint: string,
    features?: {
        temperature?: boolean,
        humidity?: boolean,
        aqi?: boolean,
        voc?: boolean,
        co?: boolean,
        co2?: boolean
    }
}