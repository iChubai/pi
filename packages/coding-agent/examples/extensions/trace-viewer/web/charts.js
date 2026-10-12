import { clock, escapeHtml as e, sample } from "./model.js";

export function chart(container, { title, subtitle, points, format, color = "green", markers = [], onSelect }) {
	const valid = points.filter((point) => Number.isFinite(point.value));
	const last = valid.at(-1);
	const max = valid.reduce((largest, point) => Math.max(largest, point.value), 1) * 1.1;
	const width = Math.max(320, container.clientWidth - 24),
		height = 190,
		left = 48,
		right = 14,
		top = 12,
		bottom = 30;
	const plotW = width - left - right,
		plotH = height - top - bottom;
	const x = (index) => left + (points.length < 2 ? plotW / 2 : (index / (points.length - 1)) * plotW);
	const y = (value) => top + plotH - (value / max) * plotH;
	const sampled = sample(points);
	let path = "",
		connected = false;
	for (const point of sampled) {
		if (!Number.isFinite(point.value)) {
			connected = false;
			continue;
		}
		path += `${connected ? "L" : "M"}${x(point.index).toFixed(2)},${y(point.value).toFixed(2)} `;
		connected = true;
	}
	const dots = sampled
		.filter(
			(point) =>
				Number.isFinite(point.value) &&
				(!Number.isFinite(points[point.index - 1]?.value) || !Number.isFinite(points[point.index + 1]?.value)),
		)
		.map((point) => `<circle class="chart-point" cx="${x(point.index)}" cy="${y(point.value)}" r="2.5"/>`)
		.join("");
	const grids = [0, 0.5, 1]
		.map(
			(ratio) =>
				`<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${top + plotH * ratio}" y2="${top + plotH * ratio}"/><text x="${left - 9}" y="${top + plotH * ratio + 4}" text-anchor="end">${e(format(max * (1 - ratio)))}</text>`,
		)
		.join("");
	const marks = markers
		.slice(-40)
		.map((marker) => {
			const closest = points.findIndex((point) => Date.parse(point.at) >= Date.parse(marker.timestamp));
			const at = closest < 0 ? points.length - 1 : closest;
			return `<line class="chart-marker" x1="${x(at)}" x2="${x(at)}" y1="${top}" y2="${top + plotH}"/><text class="marker-label" x="${x(at) + 4}" y="${top + 9}">C</text>`;
		})
		.join("");
	container.innerHTML = `<div class="panel-head"><div><h2>${e(title)}</h2><p>${e(subtitle)}</p></div><strong class="chart-latest">${last ? e(format(last.value)) : "—"}<small>latest reported</small></strong></div>
		<div class="plot ${color}" tabindex="0" role="group" aria-label="${e(title)}. Use left and right arrows to inspect calls; Enter opens details.">
		<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${e(title)} trend"><title>${e(title)}</title>${grids}${marks}<path class="chart-line" d="${path}"/>${dots}<line class="chart-cursor" x1="0" x2="0" y1="${top}" y2="${top + plotH}" visibility="hidden"/><text x="${left}" y="${height - 6}">${e(points[0] ? clock(points[0].at) : "")}</text><text x="${width - right}" y="${height - 6}" text-anchor="end">${e(points.at(-1) ? clock(points.at(-1).at) : "")}</text></svg>
		<div class="chart-tip" hidden></div>${valid.length ? "" : '<div class="chart-empty">Not captured yet<span>Missing values are not plotted as zero.</span></div>'}</div>
		<div class="chart-foot">${valid.length} / ${points.length} calls with data${markers.length ? '<span><i class="legend-marker"></i> Compaction boundary</span>' : ""}</div>`;
	const plot = container.querySelector(".plot"),
		tip = container.querySelector(".chart-tip"),
		cursor = container.querySelector(".chart-cursor");
	let selected = Math.max(0, points.length - 1);
	function show(index) {
		if (!points.length) return;
		selected = Math.max(0, Math.min(points.length - 1, index));
		const point = points[selected];
		cursor.setAttribute("x1", x(selected));
		cursor.setAttribute("x2", x(selected));
		cursor.setAttribute("visibility", "visible");
		tip.hidden = false;
		tip.innerHTML = `<b>${e(format(point.value))}</b><span>Call ${selected + 1} · ${e(clock(point.at))}</span><small>${e(point.label || "")} · click to inspect</small>`;
		tip.style.left = `${Math.max(2, Math.min(66, (x(selected) / width) * 100))}%`;
	}
	plot.addEventListener("pointermove", (event) => {
		const bounds = plot.getBoundingClientRect();
		show(
			Math.round(
				((((event.clientX - bounds.left) / bounds.width) * width - left) / plotW) * Math.max(1, points.length - 1),
			),
		);
	});
	plot.addEventListener("pointerleave", () => {
		tip.hidden = true;
		cursor.setAttribute("visibility", "hidden");
	});
	plot.addEventListener("focus", () => show(selected));
	plot.addEventListener("blur", () => {
		tip.hidden = true;
		cursor.setAttribute("visibility", "hidden");
	});
	plot.addEventListener("keydown", (event) => {
		if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
			event.preventDefault();
			show(
				event.key === "Home"
					? 0
					: event.key === "End"
						? points.length - 1
						: selected + (event.key === "ArrowRight" ? 1 : -1),
			);
		}
		if (event.key === "Enter" && points[selected]) onSelect(points[selected].id);
	});
	plot.addEventListener("click", () => {
		if (points[selected]) onSelect(points[selected].id);
	});
}
