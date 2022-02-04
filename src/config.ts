import {AccessoryConfig} from "homebridge";

export interface Config extends AccessoryConfig {
    api_endpoint?: string
}