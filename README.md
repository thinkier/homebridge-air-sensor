# homebridge-air-sensor

This plugin is designed to interact with an external API, [such as this one I made for a BME688 on a Pi Zero](https://github.com/thinkier/bme688-http-api), and expose the data to the Home app.

## Features

- Supports the following values/metrics:
    - Temperature
    - Humidity
    - Air Quality Index (1-5)
    - Volatile Organic Compounds (ppm)
    - Carbon Dioxide (ppm)

## Example Config

```json
{
  // ...
  "accessories": [
    {
      "name": "Air Quality Sensor",
      "api_endpoint": "http://192.168.1.203:5555/report.json",
      "features": {
        "aqi": true,
        "voc": true,
        "co2": true
      },
      "accessory": "AirQualitySensor"
    }
  ]
  // ...
}
```
