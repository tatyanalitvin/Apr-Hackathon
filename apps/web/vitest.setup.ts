import "@testing-library/jest-dom/vitest";

// jsdom 29 in this workspace starts with an inert localStorage (getItem/setItem/clear
// are all missing — see the `--localstorage-file` warning on boot). Install a
// conformant in-memory polyfill so tests that need Web Storage work.
if (typeof window !== "undefined") {
  const hasStorage =
    typeof window.localStorage?.getItem === "function" &&
    typeof window.localStorage?.setItem === "function" &&
    typeof window.localStorage?.clear === "function";

  if (!hasStorage) {
    const makeStorage = (): Storage => {
      const store = new Map<string, string>();
      return {
        get length() {
          return store.size;
        },
        clear() {
          store.clear();
        },
        getItem(key: string) {
          return store.has(key) ? (store.get(key) as string) : null;
        },
        key(index: number) {
          return Array.from(store.keys())[index] ?? null;
        },
        removeItem(key: string) {
          store.delete(key);
        },
        setItem(key: string, value: string) {
          store.set(key, String(value));
        },
      };
    };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: makeStorage(),
    });
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: makeStorage(),
    });
  }
}
