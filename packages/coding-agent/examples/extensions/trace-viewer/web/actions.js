export async function copyText(value, toast) {
	try {
		if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
		else {
			const input = document.createElement("textarea");
			input.value = value;
			input.style.position = "fixed";
			input.style.opacity = "0";
			(document.querySelector("dialog[open]") || document.body).append(input);
			const previous = document.activeElement;
			try {
				input.select();
				if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
			} finally {
				input.remove();
				previous?.focus({ preventScroll: true });
			}
		}
		toast("Copied.");
	} catch {
		toast("Clipboard unavailable. Use the original download instead.");
	}
}
export function itemLink(id, type) {
	const url = new URL(location.href);
	for (const key of ["entry", "call", "mode"]) url.searchParams.delete(key);
	url.searchParams.set("view", type === "entry" ? "session" : "calls");
	url.searchParams.set("item", id);
	return url.href;
}
export function showImage(source, alt = "Session image attachment") {
	if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(source)) return;
	const dialog = document.querySelector("#image-viewer");
	const image = dialog.querySelector("img");
	image.src = source;
	image.alt = alt;
	const download = dialog.querySelector("a");
	download.href = source;
	download.download = `pi-trace-image.${source.match(/^data:image\/(\w+)/i)[1].replace("jpeg", "jpg")}`;
	if (!dialog.open) dialog.showModal();
}
export function bindResizer(handle, variable, fallback, min, max, reverse = false) {
	const key = `pi-trace-${variable}`;
	const apply = (value) => {
		const width = Math.round(Math.max(min, Math.min(max, value)));
		document.documentElement.style.setProperty(variable, `${width}px`);
		handle.setAttribute("aria-valuenow", String(width));
		try {
			localStorage.setItem(key, String(width));
		} catch {}
		window.dispatchEvent(new Event("resize"));
	};
	try {
		const stored = Number(localStorage.getItem(key));
		if (stored >= min && stored <= max) apply(stored);
	} catch {}
	handle.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		event.preventDefault();
		const start = event.clientX;
		const width = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(variable)) || fallback;
		handle.setPointerCapture(event.pointerId);
		handle.classList.add("dragging");
		const move = (next) => apply(width + (next.clientX - start) * (reverse ? -1 : 1));
		const finish = () => {
			handle.classList.remove("dragging");
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("lostpointercapture", finish);
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("lostpointercapture", finish);
	});
	handle.addEventListener("keydown", (event) => {
		if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const width = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(variable)) || fallback;
		apply(
			event.key === "Home"
				? min
				: event.key === "End"
					? max
					: width + (event.key === "ArrowRight" ? 20 : -20) * (reverse ? -1 : 1),
		);
	});
}
const imageViewer = document.querySelector("#image-viewer");
imageViewer.querySelector("button").addEventListener("click", () => imageViewer.close());
imageViewer.addEventListener("click", (event) => {
	if (event.target === imageViewer) imageViewer.close();
});
imageViewer.addEventListener("close", () => {
	imageViewer.querySelector("img").removeAttribute("src");
	imageViewer.querySelector("a").removeAttribute("href");
});
