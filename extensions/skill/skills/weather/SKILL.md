---
name: weather
description: 查询指定城市的实时天气信息
---

# Weather Skill

当用户询问天气时，使用此技能获取实时天气数据。

## 使用方式

调用天气 API 获取指定城市的当前天气，包括温度、湿度、风速等信息。

## 参数

- `city`: 城市名称（必填）
- `unit`: 温度单位，celsius 或 fahrenheit（可选，默认 celsius）

## 输出格式

返回结构化的天气信息，包含温度、体感温度、湿度、风向风速、天气状况描述。
