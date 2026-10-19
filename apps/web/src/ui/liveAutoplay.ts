import { useSyncExternalStore } from "react";

/**
 * Live Photo 自动播放：默认打开（查看器打开时播放一次，桌面上悬停再播放；有声音，浏览器不允许时静音）。
 * 关掉之后只在点 / 按住 Live 按钮时播放。和原图模式一样只是这台设备上的偏好，存在 localStorage（读写失败就当打开）。
 */
const KEY = "nana:live-autoplay";
const listeners = new Set<() => void>();

function read(): boolean {
	try {
		return localStorage.getItem(KEY) !== "0";
	} catch {
		return true;
	}
}

let current = read();

export function setLiveAutoplay(on: boolean) {
	current = on;
	try {
		if (on) localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, "0");
	} catch {
		// 存不下也照样在当前页面生效
	}
	listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

export function useLiveAutoplay(): boolean {
	return useSyncExternalStore(subscribe, () => current);
}
