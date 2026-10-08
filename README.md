# Less Snow, Far More Complaints

An interactive visualization comparing NYC 311 snow and ice complaints from Jan. 1–Feb. 6 in 2016 and 2026, alongside snowfall data from Central Park.

Each pile represents complaints in a ZIP code, with height scaled to the number of complaints. The visualization uses the same scale across both years to make the comparison easier to see.

## Data

- NYC Open Data — 311 Service Requests
- NOAA GHCN-Daily — Central Park weather station
- NYC Open Data — Borough Boundaries

The data was cleaned and aggregated with Python before being used in the visualization.

## Built with

JavaScript · Three.js · GSAP · Python · pandas · HTML/CSS

## Notes

The two years use slightly different 311 complaint categories. Reports without usable ZIP or location data are excluded from the mapped piles. The comparison covers Jan. 1–Feb. 6 in each year, not the full winter.
