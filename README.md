# ScarCrash — Project Website

Source for the [ScarCrash](https://scarcrash.github.io/) landing page: a synthetic multi-vehicle
collision dataset built in CARLA. Plain HTML/CSS, no build step — deployed via GitHub Pages
straight from this repo.

- **Code**: https://github.com/ScarCrash/CARLA_Collision_Scenarios_Simulation
- **Dataset**: https://github.com/ScarCrash/CARLA_Collision_Scenarios_Simulation/releases/tag/release-assets

## Editing

Everything is in `index.html`, styled with [Bulma](https://bulma.io/) (`static/css/`) plus a small
set of overrides in `static/css/index.css`. To preview locally, just open `index.html` directly in
a browser — no server needed.

To add the demo video/GIF and sample gallery images later: replace the `.placeholder-box` divs in
`index.html` (marked "Demo video coming soon" / "Sample camera and LiDAR frames will be added
here") with real `<video>`/`<img>` elements, and drop the media files under `static/videos/` /
`static/images/`.

## Website License

Built from the [Academic Project Page Template](https://github.com/eliahuhorwitz/Academic-project-page-template).
This website's source is licensed under a
[Creative Commons Attribution-ShareAlike 4.0 International License](http://creativecommons.org/licenses/by-sa/4.0/).
