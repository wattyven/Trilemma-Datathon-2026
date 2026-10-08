# Trilemma-Datathon-2026
Trilemma Datathon 2026

## Problem Statement

Sunlight plays an important role in how people use their outdoor spaces, but it is often difficult to know how much sunlight a property actually receives throughout the day. This can be especially important for people who are getting into gardening, as different plants and crops have different sunlight and shade requirements. The amount of sunlight can also affect how comfortably people can use their backyard or lawn for activities such as relaxing, dining, or spending time outdoors.

For people considering a new home, sunlight can also be an important factor in deciding whether a property is right for them. However, it is difficult to assess how much direct sunlight a yard will receive simply by looking at a property listing or visiting it at a single time of day. Trees, buildings, surrounding structures, and the changing position of the sun can create significant differences in sunlight across a property.

Currently, there is no readily accessible tool that allows people to enter a property address and determine how much sunlight their outdoor space receives over a specific period of time.


## Scope

This tool will be limited to the BC lower mainland, which is home to approximately 3.1 million people. The scope is not restricted to property type, so even commercial property managers could use it. There are approximately 1.15 million properties in the area.


## Currently existing solutions and their gaps

ShadeMap is an existing tool that allows users to visualize sunlight and shade patterns for a given location. However, its level of detail is limited for property-level analysis. Buildings are represented primarily as simplified cubes, without detailed structural features that may affect shade, and lawn-specific features such as trees, fences, or other obstacles are not fully accounted for. In addition, the free version focuses on daily sunlight and shade patterns, rather than providing averaged sunlight estimates over longer periods that account for seasonal variation. There are other similar tools with the same gaps. These limitations make it difficult for users to accurately determine which specific areas of a property receive the most or least sunlight over an extended period.


## Proposed solution

We aim to address this gap by combining LiDAR data, a geocoder, and SunCalc to create a tool that estimates sunlight availability for a specific property. Users will enter an address and select a time range of at least one month, allowing sunlight data to be averaged over the selected period. The tool will account for seasonal patterns in the sun's position, daylight hours, and weather conditions to provide a more representative estimate of sunlight conditions. It will output the average minimum and maximum hours of sunlight during the selected period, along with the 1 m² area of the property that receives the most sunlight and the 1 m² area that receives the least sunlight.

By providing both the average range of sunlight and the locations of the sunniest and shadiest areas, the tool will give homeowners, gardeners, and prospective homebuyers a simple way to better understand how sunlight varies across their property and throughout the seasons, helping them make more informed decisions about how they use or evaluate their outdoor space.


## Data Sources

LiDAR: https://open-data-portal-metrovancouver.hub.arcgis.com/search?q=lidar
Geocoder: https://www2.gov.bc.ca/gov/content/data/geographic-data-services/location-services/geocoder
SunCalc: https://github.com/mourner/suncalc
