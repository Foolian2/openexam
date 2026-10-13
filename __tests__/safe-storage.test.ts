import { afterEach, describe, expect, it } from "vitest"
import {
  getLocalStorage,
  readLocal,
  readSession,
  removeLocal,
  writeLocal,
  writeSession,
} from "@/lib/safe-storage"

// A browser that blocks site data throws on the storage property itself, so a
// `typeof window` guard never sees it coming. Every helper here has to absorb
// that: in this app the alternative is a student who cannot open or submit an
// exam because their browser is set to block cookies.
function install(name: "localStorage" | "sessionStorage", value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, value })
}

function installThrowing(name: "localStorage" | "sessionStorage") {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new Error("SecurityError: storage is disabled")
    },
  })
}

function fakeStore() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

const originals = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
  sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
}

afterEach(() => {
  for (const [name, desc] of Object.entries(originals)) {
    if (desc) Object.defineProperty(globalThis, name, desc)
    else delete (globalThis as Record<string, unknown>)[name]
  }
})

describe("safe-storage with storage denied", () => {
  it("reads return null instead of throwing", () => {
    installThrowing("localStorage")
    installThrowing("sessionStorage")
    expect(readLocal("k")).toBeNull()
    expect(readSession("k")).toBeNull()
    expect(getLocalStorage()).toBeNull()
  })

  it("writes report failure instead of throwing", () => {
    installThrowing("localStorage")
    installThrowing("sessionStorage")
    expect(writeLocal("k", "v")).toBe(false)
    expect(writeSession("k", "v")).toBe(false)
    expect(() => removeLocal("k")).not.toThrow()
  })

  it("a setItem that throws is reported, not propagated", () => {
    install("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError")
      },
      removeItem: () => {},
    })
    expect(writeLocal("k", "v")).toBe(false)
  })
})

describe("safe-storage when absent (server render)", () => {
  it("degrades to null/false", () => {
    delete (globalThis as Record<string, unknown>).localStorage
    delete (globalThis as Record<string, unknown>).sessionStorage
    expect(readLocal("k")).toBeNull()
    expect(readSession("k")).toBeNull()
    expect(writeLocal("k", "v")).toBe(false)
    expect(writeSession("k", "v")).toBe(false)
    expect(getLocalStorage()).toBeNull()
  })
})

describe("safe-storage when available", () => {
  it("round-trips values", () => {
    const local = fakeStore()
    const sess = fakeStore()
    install("localStorage", local)
    install("sessionStorage", sess)
    expect(writeLocal("k", "v")).toBe(true)
    expect(readLocal("k")).toBe("v")
    removeLocal("k")
    expect(readLocal("k")).toBeNull()
    expect(writeSession("s", "t")).toBe(true)
    expect(readSession("s")).toBe("t")
  })
})
