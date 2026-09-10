"""Create simple SVG figures from the verified Question 1 result JSON."""

import html
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "outputs"
DATA = json.loads((OUTPUT / "result1_internal.json").read_text(encoding="utf-8"))

times = DATA["times"]
radii_cm = [x * 100.0 for x in DATA["radii_m"]]
temperature = DATA["temperature_C"]
moisture = DATA["moisture_kg_per_kg"]
env_t = DATA["environment"]["temperature"]
env_c = DATA["environment"]["moisture"]


def esc(value):
    return html.escape(str(value))


def line_path(xs, ys, sx, sy):
    return "M " + " L ".join(f"{sx(x):.2f},{sy(y):.2f}" for x, y in zip(xs, ys))


def chart(title, xlabel, ylabel, series, filename, x_ticks=None, y_log=False):
    width, height = 820, 460
    left, top, right, bottom = 82, 54, 24, 82
    plot_w, plot_h = width - left - right, height - top - bottom
    all_x = [x for _, xs, _, _, _ in series for x in xs]
    all_y = [y for _, _, ys, _, _ in series for y in ys]
    xmin, xmax = min(all_x), max(all_x)
    if y_log:
        ymin, ymax = min(y for y in all_y if y > 0), max(all_y)
        import math
        ly0, ly1 = math.log10(ymin), math.log10(ymax)
        def sy(y):
            return top + plot_h * (1 - (math.log10(max(y, ymin)) - ly0) / (ly1 - ly0))
    else:
        ymin, ymax = min(all_y), max(all_y)
        pad = 0.06 * max(ymax - ymin, 1e-12)
        ymin, ymax = ymin - pad, ymax + pad
        def sy(y):
            return top + plot_h * (1 - (y - ymin) / (ymax - ymin))
    def sx(x):
        return left + plot_w * (x - xmin) / (xmax - xmin)
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="white"/>',
        f'<text x="{width/2:.0f}" y="28" text-anchor="middle" font-family="Arial" font-size="17" font-weight="600">{esc(title)}</text>',
        f'<line x1="{left}" y1="{top+plot_h}" x2="{left+plot_w}" y2="{top+plot_h}" stroke="#444"/>',
        f'<line x1="{left}" y1="{top}" x2="{left}" y2="{top+plot_h}" stroke="#444"/>',
        f'<text x="{left+plot_w/2:.0f}" y="{height-24}" text-anchor="middle" font-family="Arial" font-size="13">{esc(xlabel)}</text>',
        f'<text x="18" y="{top+plot_h/2:.0f}" transform="rotate(-90 18 {top+plot_h/2:.0f})" text-anchor="middle" font-family="Arial" font-size="13">{esc(ylabel)}</text>',
    ]
    xticks = x_ticks or [xmin, (xmin + xmax) / 2, xmax]
    for x in xticks:
        px = sx(x)
        lines.append(f'<line x1="{px:.2f}" y1="{top+plot_h}" x2="{px:.2f}" y2="{top+plot_h+5}" stroke="#444"/>')
        lines.append(f'<text x="{px:.2f}" y="{top+plot_h+23}" text-anchor="middle" font-family="Arial" font-size="11">{esc(round(x, 3))}</text>')
    colors = ["#1f77b4", "#d62728", "#444444", "#2ca02c", "#9467bd", "#ff7f0e"]
    for index, (label, xs, ys, color, dash) in enumerate(series):
        dash_attr = ' stroke-dasharray="7 5"' if dash else ""
        lines.append(f'<path d="{line_path(xs, ys, sx, sy)}" fill="none" stroke="{color or colors[index % len(colors)]}" stroke-width="2"{dash_attr}/>')
        lx = left + 20 + index * 180
        lines.append(f'<line x1="{lx}" y1="{top-20}" x2="{lx+24}" y2="{top-20}" stroke="{color or colors[index % len(colors)]}" stroke-width="2"{dash_attr}/>')
        lines.append(f'<text x="{lx+30}" y="{top-16}" font-family="Arial" font-size="11">{esc(label)}</text>')
    lines.append("</svg>")
    (OUTPUT / filename).write_text("\n".join(lines), encoding="utf-8")


chart(
    "Question 1 temperature evolution",
    "Time (s)",
    "Temperature (deg C)",
    [
        ("Center r=0 cm", times, [row[0] for row in temperature], "#1f77b4", False),
        ("Surface r=2 cm", times, [row[-1] for row in temperature], "#d62728", False),
        ("Environment", [row[0] for row in env_t], [row[1] for row in env_t], "#444444", True),
    ],
    "temperature_time_series.svg",
    x_ticks=[0, 600, 1200, 1800],
)

chart(
    "Question 1 moisture evolution",
    "Time (s)",
    "Moisture content (kg/kg dry basis)",
    [
        ("Center r=0 cm", times, [row[0] for row in moisture], "#1f77b4", False),
        ("Surface r=2 cm", times, [row[-1] for row in moisture], "#d62728", False),
        ("Environment", [row[0] for row in env_c], [row[1] for row in env_c], "#444444", True),
    ],
    "moisture_time_series.svg",
    x_ticks=[0, 600, 1200, 1800],
)

selected = [100, 600, 1800]
temp_series = []
moist_series = []
for time in selected:
    index = time - 1
    color = {100: "#1f77b4", 600: "#d62728", 1800: "#2ca02c"}[time]
    temp_series.append((f"{time} s", radii_cm, temperature[index], color, False))
    moist_series.append((f"{time} s", radii_cm, moisture[index], color, False))
chart("Radial temperature profiles", "Radius from center (cm)", "Temperature (deg C)", temp_series, "radial_temperature_profiles.svg", x_ticks=[0, 1, 2])
chart("Radial moisture profiles", "Radius from center (cm)", "Moisture content (kg/kg)", moist_series, "radial_moisture_profiles.svg", x_ticks=[0, 1, 2])

convergence = DATA["convergence"]
labels = ["space N80", "space N160", "time dt0.25", "time dt0.5"]
svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="820" height="460" viewBox="0 0 820 460">',
    '<rect width="100%" height="100%" fill="white"/>',
    '<text x="410" y="28" text-anchor="middle" font-family="Arial" font-size="17" font-weight="600">Independent refinement checks</text>',
]
left, top, plot_w, plot_h = 82, 54, 714, 300
all_errors = [max(row["compare"]["maxTemperature"], row["compare"]["maxMoisture"]) for row in convergence]
import math
log_min = math.floor(math.log10(min(all_errors)))
log_max = math.ceil(math.log10(max(all_errors)))
def ybar(value):
    return top + plot_h * (1 - (math.log10(value) - log_min) / (log_max - log_min))
svg += [f'<line x1="{left}" y1="{top+plot_h}" x2="{left+plot_w}" y2="{top+plot_h}" stroke="#444"/>', f'<line x1="{left}" y1="{top}" x2="{left}" y2="{top+plot_h}" stroke="#444"/>']
bar_w = 26
for i, row in enumerate(convergence):
    center = left + (i + 0.5) * plot_w / len(convergence)
    for offset, key, color in [(-18, "maxTemperature", "#1f77b4"), (18, "maxMoisture", "#d62728")]:
        value = row["compare"][key]
        y = ybar(value)
        svg.append(f'<rect x="{center+offset-bar_w/2:.2f}" y="{y:.2f}" width="{bar_w}" height="{top+plot_h-y:.2f}" fill="{color}"/>')
    svg.append(f'<text x="{center:.2f}" y="{top+plot_h+24}" text-anchor="middle" font-family="Arial" font-size="11">{esc(labels[i])}</text>')
for power in range(log_min, log_max + 1):
    y = ybar(10**power)
    svg.append(f'<line x1="{left-5}" y1="{y:.2f}" x2="{left}" y2="{y:.2f}" stroke="#444"/>')
    svg.append(f'<text x="{left-10}" y="{y+4:.2f}" text-anchor="end" font-family="Arial" font-size="11">1e{power}</text>')
svg += [
    f'<text x="{left+plot_w/2:.0f}" y="{top+plot_h+57}" text-anchor="middle" font-family="Arial" font-size="13">Comparison</text>',
    f'<text x="18" y="{top+plot_h/2:.0f}" transform="rotate(-90 18 {top+plot_h/2:.0f})" text-anchor="middle" font-family="Arial" font-size="13">Maximum absolute difference</text>',
    '<rect x="570" y="35" width="14" height="14" fill="#1f77b4"/><text x="590" y="47" font-family="Arial" font-size="11">Temperature</text>',
    '<rect x="680" y="35" width="14" height="14" fill="#d62728"/><text x="700" y="47" font-family="Arial" font-size="11">Moisture</text>',
    "</svg>",
]
(OUTPUT / "convergence_checks.svg").write_text("\n".join(svg), encoding="utf-8")

summary = {
    "figures": [
        "temperature_time_series.svg",
        "moisture_time_series.svg",
        "radial_temperature_profiles.svg",
        "radial_moisture_profiles.svg",
        "convergence_checks.svg",
    ],
    "balance_error": DATA["balance"]["massBalanceError"],
    "max_picard_residual": DATA["balance"]["maxPicardResidual"],
}
(OUTPUT / "figure_manifest.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
