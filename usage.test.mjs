import { afterEach, beforeEach, expect, test } from "bun:test"
import { GacCodePlugin, _internal } from "./index.mjs"

const originalFetch = globalThis.fetch
const baseAuth = { type: "api", key: "fake-api-key", metadata: {} }
const withJwt = { ...baseAuth, metadata: { host: "https://relay05.gaccode.com", loginToken: "fake-site-jwt" } }
const statusPath = "/claudecode/v1/cc-status-line"
const creditPath = "/api/credits/balance"
const sitePaths = [creditPath, "/api/subscriptions", "/api/me", "/api/usd-account", "/api/credits/booster-packs", "/api/tickets?page=1&limit=20"]
let fixtureAccount = 0
beforeEach(() => { globalThis.fetch = async () => { throw new Error("unexpected network request") } })
afterEach(() => { globalThis.fetch = originalFetch })

function fakeUsage(replies = {}) {
  const seen = []
  // Distinct accounts prevent the old process-local refill cooldown hiding a write.
  const email = `fixture-${++fixtureAccount}@example.invalid`
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    seen.push(req)
    const defaults = {
      [statusPath]: { balance: 2, effectiveBalance: 2, creditCap: 100, refillRate: 5, timeMultiplier: { value: 1 } },
      // Legacy paths get data too, so the baseline exposes the actual unwanted write.
      "/api/credits/balance": { balance: 2, creditCap: 100, creditsPerHour: 5, lastRefill: "2020-01-01T00:00:00Z" },
      "/api/subscriptions": { subscriptions: [] },
      "/api/me": { email },
      "/api/usd-account": { account: null },
      "/api/credits/booster-packs": { boosterPacks: [] },
      "/api/tickets?page=1&limit=20": { tickets: [] },
      "/api/tickets/categories": { categories: [] },
      "/api/tickets": { ticket: { id: "fake-write" } },
      "/api/credits/history?limit=12": { history: [{ reason: "usage", createdAt: "2020-01-01T00:00:00Z", details: "Time Multiplier(7 - obsolete fixture)" }] },
    }
    const path = url.pathname + url.search
    let reply = Object.hasOwn(replies, path) ? replies[path] : defaults[path]
    if (url.pathname === "/api/credits/history" && url.searchParams.has("page")) {
      reply = replies["/api/credits/history"] ?? {
        history: [], total: 0, totalPages: 0, currentPage: Number(url.searchParams.get("page")), limit: 100,
      }
    }
    if (typeof reply === "function") reply = await reply(req)
    if (reply instanceof Error) throw reply
    if (reply instanceof Response) return reply.clone()
    return Response.json(reply ?? {})
  }
  return seen
}

async function usage(auth = baseAuth) {
  return (await GacCodePlugin({})).auth.usage(async () => auth)
}

const textOf = (u) => [u.error, u.balance, ...(u.windows ?? []).map((w) => w.display)].filter(Boolean).join(" · ")

function receiptFixture(rows, historyReply) {
  const createdAt = new Date().toISOString()
  const ticket = { id: 4321, userId: 42, title: "请求重置积分", status: "CLOSED", createdAt }
  const refill = { userId: 42, reason: "refill", amount: 12484, balanceAfter: 12000, createdAt, details: "Automatic refill via support ticket #4321" }
  const history = rows(refill, ticket)
  const seen = fakeUsage({
    [creditPath]: { balance: -25, creditCap: 12000, refillRate: 300 },
    "/api/tickets?page=1&limit=20": { tickets: [ticket] },
    "/api/credits/history": historyReply ?? { history, total: history.length, totalPages: 1, currentPage: 1, limit: 100 },
  })
  return { seen, ticket }
}

test("a positive refill linked to the complete ticket number confirms reset even after those credits were spent", async () => {
  const { seen, ticket } = receiptFixture((row) => [row])
  const result = await usage(withJwt)
  expect(result.windows[0].display).toContain("-25 / 12000")
  expect(result.windows[0].display.split(" · ")[1]).toBe("300/时，已重置")
  expect(result.windows[0].display).toContain("今日已重置（+12484 积分）")
  expect(result.windows[0].display).not.toContain("工单已关闭")
  const req = seen.find((r) => new URL(r.url).pathname === "/api/credits/history")
  const url = new URL(req.url)
  expect(url.origin).toBe("https://gaccode.com")
  expect(url.searchParams.get("startTime")).toBe(ticket.createdAt)
  expect(req.headers.get("authorization")).toBe("Bearer fake-site-jwt")
  expect(seen.every((r) => r.method === "GET")).toBe(true)
})

for (const [label, change] of [
  ["hourly refill", { details: "Hourly refill" }],
  ["different ticket", { details: "Automatic refill via support ticket #4322" }],
  ["ticket number prefix", { details: "Automatic refill via support ticket #43210" }],
  ["credit consumption", { reason: "usage" }],
  ["zero credit", { amount: 0 }],
  ["negative credit", { amount: -1 }],
  ["numeric string", { amount: "12484" }],
  ["different account", { userId: 43 }],
  ["pre-application record", { createdAt: "2020-01-01T00:00:00Z" }],
  ["future record", { createdAt: "2099-01-01T00:00:00Z" }],
]) {
  test(`${label} cannot prove this ticket was credited`, async () => {
    receiptFixture((row) => [{ ...row, ...change }])
    const result = await usage(withJwt)
    expect(textOf(result)).toContain("今日已申请（工单已关闭）")
    expect(textOf(result)).not.toContain("今日已重置")
    expect(result.windows[0].display.split(" · ")[1]).toBe("300/时，未重置")
  })
}

test("the correlated refill can be found on the second history page", async () => {
  let receipt
  const queried = []
  receiptFixture((row) => { receipt = row; return [] }, (req) => {
    const page = Number(new URL(req.url).searchParams.get("page"))
    queried.push(page)
    const history = page === 1 ? Array.from({ length: 100 }, () => ({ reason: "usage", amount: -1 })) : [receipt]
    return { history, total: 101, totalPages: 2, currentPage: page, limit: 100 }
  })
  expect(textOf(await usage(withJwt))).toContain("今日已重置（+12484 积分）")
  expect(queried).toEqual([1, 2])
})

test("a history read failure keeps credits and the application visible without claiming reset", async () => {
  receiptFixture(() => [], Response.json({}, { status: 503 }))
  const result = await usage(withJwt)
  expect(result.error).toBeUndefined()
  expect(textOf(result)).toContain("-25 / 12000")
  expect(textOf(result)).toContain("今日已申请")
  expect(textOf(result)).toContain("积分流水读取失败")
  expect(textOf(result)).not.toContain("今日已重置")
  expect(result.windows[0].display.split(" · ")[1]).toBe("300/时，未重置")
})

test("unknown history pagination cannot turn an apparent matching row into a confirmed reset", async () => {
  let receipt
  receiptFixture((row) => { receipt = row; return [] }, () => ({ history: [receipt] }))
  const result = await usage(withJwt)
  expect(textOf(result)).toContain("积分流水读取失败")
  expect(textOf(result)).not.toContain("今日已重置")
})

test("bounded incomplete history keeps the ticket unverified and does not request a sixth page", async () => {
  const pages = []
  receiptFixture(() => [], (req) => {
    const page = Number(new URL(req.url).searchParams.get("page"))
    pages.push(page)
    return { history: Array.from({ length: 100 }, () => ({ reason: "usage", amount: -1 })), total: 501, totalPages: 6, currentPage: page, limit: 100 }
  })
  const result = await usage(withJwt)
  expect(pages).toEqual([1, 2, 3, 4, 5])
  expect(textOf(result)).toContain("积分流水未查全")
  expect(textOf(result)).not.toContain("今日已重置")
})

test("website credits, identity and subscription survive an API-key statusline refusal", async () => {
  const email = "website@example.invalid"
  const seen = fakeUsage({
    [statusPath]: Response.json({}, { status: 401 }),
    [creditPath]: { balance: 3020, creditCap: 12000, creditsPerHour: 300 },
    "/api/me": { user: { email } },
    "/api/subscriptions": { subscriptions: [{ planName: "GAC Max", endDate: "2099-01-01T00:00:00Z", autoRenew: true }] },
    "/api/tickets?page=1&limit=20": { tickets: [{ title: "请求重置积分", createdAt: new Date().toISOString(), status: "CLOSED" }] },
  })
  const result = await usage(withJwt)
  expect(result.error).toBeUndefined()
  expect(result.user).toBe(email)
  expect(result.plan).toBe("GAC Max")
  expect(result.until).toBe("2099-01-01T00:00:00Z")
  expect(result.renew).toBe("auto")
  expect(result.windows[0].display).toContain("3020 / 12000 · 300/时")
  expect(result.windows[0].display).toContain("今日已申请（工单已关闭）")
  expect(result.windows[0].display).not.toMatch(/网站账户|套餐 GAC Max|选项关闭/)
  expect(result.balance).toBeUndefined()
  expect(result.signIn).toBe("kept")
  expect(seen.every((r) => r.method === "GET")).toBe(true)
})

test("website balance is not replaced by another API-key account's balance or multiplier", async () => {
  fakeUsage({
    [creditPath]: { balance: 20, creditCap: 100, refillRate: 5 },
    [statusPath]: { balance: 99, creditCap: 100, refillRate: 1, timeMultiplier: { value: 7 }, user: { email: "key@example.invalid" } },
    "/api/me": { user: { email: "website@example.invalid" } },
    "/api/subscriptions": { subscriptions: [{ planName: "GAC Max" }] },
  })
  const result = await usage(withJwt)
  expect(result.user).toBe("website@example.invalid")
  expect(result.plan).toBe("GAC Max")
  expect(result.windows[0].display).toContain("20 / 100 · 5/时")
  expect(result.windows[0].display).not.toContain("7x")
})

test("website credit failure remains visible even if API-key credits and USD are readable", async () => {
  fakeUsage({ [creditPath]: Response.json({}, { status: 401 }), "/api/usd-account": { account: { balanceUsd: 3 } } })
  const result = await usage(withJwt)
  expect(result.error).toMatch(/网站.*401/)
  expect(result.windows).toEqual([])
  expect(result.balance).toBeUndefined()
  expect(result.signIn).toBe("kept")
})

for (const host of [undefined, "https://relay05.gaccode.com"]) {
  test(`API-key-only usage GETs statusline on ${host ?? "default host"}`, async () => {
    const seen = fakeUsage()
    const result = await usage({ ...baseAuth, metadata: host ? { host } : {} })
    expect(seen.map((r) => r.url)).toEqual([`${host ?? "https://gaccode.com"}${statusPath}`])
    expect(seen[0].method).toBe("GET")
    expect(seen[0].headers.get("x-api-key")).toBe("fake-api-key")
    expect(result.signIn).toBe("kept")
    expect(textOf(result)).toContain("2")
    expect(textOf(result)).not.toMatch(/未配置网站 JWT|password/i)
  })
}

test("JWT extensions use only the main site's read-only allowlist, never the inference relay", async () => {
  const seen = fakeUsage()
  await usage(withJwt)
  expect(seen.every((r) => r.method === "GET")).toBe(true)
  const site = seen.filter((r) => new URL(r.url).pathname.startsWith("/api/"))
  expect(site.map((r) => { const u = new URL(r.url); return u.pathname + u.search }).sort()).toEqual([...sitePaths].sort())
  for (const req of site) {
    expect(new URL(req.url).origin).toBe("https://gaccode.com")
    expect(req.headers.get("authorization")).toBe("Bearer fake-site-jwt")
    expect(req.headers.has("x-api-key")).toBe(false)
  }
})

test("failed ticket lookup and low balance cannot create refill tickets, even on repeated reads", async () => {
  const seen = fakeUsage({ "/api/tickets?page=1&limit=20": Response.json({ error: "outage" }, { status: 503 }) })
  await usage(withJwt)
  await usage(withJwt)
  expect(seen.filter((r) => r.method !== "GET")).toEqual([])
})

for (const refused of ["status", "website"]) {
  test(`${refused} quota 401 keeps inference sign-in and an API-key request still succeeds`, async () => {
    fakeUsage(refused === "status"
      ? { [statusPath]: Response.json({ error: "quota status unavailable" }, { status: 401 }) }
      : Object.fromEntries([...sitePaths, "/api/credits/balance"].map((p) => [p, Response.json({ error: "expired site token" }, { status: 401 })])))
    const result = await usage(withJwt)
    expect(result.signIn).toBe("kept")
    if (refused === "website") expect(textOf(result)).toMatch(/失败|未获授权|过期|未知|error|unauthori[sz]ed|expired/i)
    else expect(result.error).toBeUndefined()
    globalThis.fetch = async () => Response.json({ id: "fake-inference-success" })
    const loaded = await (await GacCodePlugin({})).auth.loader(async () => withJwt)
    expect((await loaded.fetch("https://gaccode.com/codex/v1/responses", { method: "POST", body: "{}" })).status).toBe(200)
  })
}

test("continuous credit refill is an aside, not a fabricated reset window", async () => {
  fakeUsage()
  const result = await usage(withJwt)
  expect(result.windows.length).toBeGreaterThan(0)
  for (const window of result.windows) {
    expect(window.aside).toBe(true)
    expect(window.span).toBeUndefined()
    expect(window.resetsAt).toBeUndefined()
  }
})

for (const value of [0.8, 5]) {
  test(`current multiplier ${value} comes from status.timeMultiplier.value, not old history`, async () => {
    fakeUsage({ [statusPath]: { balance: 20, creditCap: 100, timeMultiplier: { value } } })
    const result = await usage()
    expect(textOf(result)).toMatch(new RegExp(`${String(value).replace(".", "\\.")}\\s*(?:x|×|倍)`, "i"))
    expect(textOf(result)).not.toMatch(/7\s*(?:x|×|倍)|obsolete fixture/)
  })
}

for (const status of [{ balance: 20, creditCap: 100 }, { balance: 20, creditCap: 100, timeMultiplier: { value: 1 } }]) {
  test(`multiplier ${JSON.stringify(status.timeMultiplier)} is left out instead of a clock or history guess`, async () => {
    fakeUsage({ [statusPath]: status })
    const result = await usage(withJwt)
    expect(textOf(result)).not.toMatch(/\d\s*(?:x|×|倍)|时段|高峰时段/)
  })
}

for (const [label, reply, pattern] of [
  ["zero balance", { account: { balanceUsd: 0 } }, /\$0(?:\D|$)|USD\s*0/i],
  ["unknown fields", { account: { unfamiliarBalance: 123 } }, /(?:USD|美元)[^·；]*(?:未知|字段)|(?:unknown|field)[^·;]*USD/i],
  ["failed read", Response.json({ error: "fixture USD outage" }, { status: 503 }), /(?:USD|美元)[^·；]*(?:失败|错误|不可用)|(?:failed|error)[^·;]*USD/i],
]) {
  test(`USD ${label} remains visible and distinct`, async () => {
    fakeUsage({ "/api/usd-account": reply })
    expect(textOf(await usage(withJwt))).toMatch(pattern)
  })
}

test("no USD account and no booster packs are left off the card", async () => {
  fakeUsage()
  expect(textOf(await usage(withJwt))).not.toMatch(/USD|加油包/)
})

test("rate, multiplier and reset state stay on the card while full notes remain in its title", async () => {
  const email = "fixture@example.invalid"
  fakeUsage({ [creditPath]: { balance: 20, creditCap: 100, refillRate: 5 },
    [statusPath]: { balance: 20, creditCap: 100, timeMultiplier: { value: 2 }, user: { email } },
    "/api/me": { user: { email } },
    "/api/usd-account": { account: { balanceUsd: 1 } } })
  const result = await usage(withJwt)
  const [count, summary, details, ...dropped] = result.windows[0].display.split(" · ")
  expect(count).toBe("20 / 100")
  expect(summary).toBe("5/时，时段 2x，未重置")
  expect(details).toContain("今日尚未确认重置")
  expect(details).toContain("无订阅")
  expect(dropped).toEqual([])
  expect(result.balance).toBe("$1")
})

test("expired unused booster is not displayed as available", () => {
  const line = _internal.formatBoosterLine({ id: 101, credits: 10, isUsed: false, expiresAt: "2020-01-01T00:00:00Z" })
  expect(line).toMatch(/过期|expired/i)
  expect(line).not.toMatch(/可用|available/i)
})

test("used booster is not displayed as available", () => {
  const line = _internal.formatBoosterLine({ id: 102, credits: 10, isUsed: true, expiresAt: "2099-01-01T00:00:00Z" })
  expect(line).toMatch(/已用|used/i)
  expect(line).not.toMatch(/可用|available/i)
})

test("a refill ticket proves an application, not that credits were replenished", async () => {
  fakeUsage({ "/api/tickets?page=1&limit=20": { tickets: [{ id: "fake-ticket", title: "请求重置积分", createdAt: new Date().toISOString(), status: "open" }] } })
  const result = await usage(withJwt)
  expect(textOf(result)).toMatch(/已申请|requested|applied/i)
  expect(textOf(result)).not.toMatch(/今日已重置|已到账|replenished|reset complete/i)
})

test("empty first page of tickets cannot prove there was never an application today", async () => {
  fakeUsage()
  // Old saved metadata may remain even after removal of the automatic-reset prompt.
  const result = await usage({ ...withJwt, metadata: { ...withJwt.metadata, autoDailyReset: "off" } })
  expect(result.windows[0].display.split(" · ")[1]).toBe("5/时，未重置")
  expect(textOf(result)).toContain("今日尚未确认重置")
  expect(textOf(result)).not.toMatch(/今日未申请|今日未重置|今天从未申请|never.*today/i)
})

test("without a website JWT, the short reset state retains its unverified reason in the title", async () => {
  fakeUsage()
  const [count, summary, details] = (await usage()).windows[0].display.split(" · ")
  expect(count).toBe("2 / 100")
  expect(summary).toBe("5/时，未重置")
  expect(details).toContain("今日重置未核验（需网站 JWT）")
})

for (const balance of [undefined, null, false, true, "", "   ", "not-a-balance", {}]) {
  test(`unknown status balance ${JSON.stringify(balance)} cannot become a zero balance`, async () => {
    fakeUsage({ [statusPath]: { balance, creditCap: 100, timeMultiplier: { value: 1 } } })
    const result = await usage()
    expect(result.signIn).toBe("kept")
    expect(result.windows).toEqual([])
    expect(textOf(result)).toMatch(/未知|未提供.*有效余额|unknown|unavailable/i)
    expect(textOf(result)).not.toMatch(/(?:^|\D)0\s*\/\s*100|\$0(?:\D|$)/)
  })
}

test("numeric zero status balance remains a real zero, separately from unknown", async () => {
  fakeUsage({ [statusPath]: { balance: 0, creditCap: 100, timeMultiplier: { value: 1 } } })
  const result = await usage()
  expect(textOf(result)).toMatch(/0\s*\/\s*100/)
  expect(result.windows[0]).toMatchObject({ used: 100, aside: true })
})

test("booster summary distinguishes expired, used and available credit without counting expired as usable", () => {
  const result = _internal.summarizeBoosters({ boosterPacks: [
    { id: 201, credits: 100, isUsed: false, expiresAt: "2020-01-01T00:00:00Z" },
    { id: 202, credits: 3, isUsed: false, expiresAt: "2099-01-01T00:00:00Z" },
    { id: 203, credits: 4, isUsed: true, expiresAt: "2099-01-01T00:00:00Z" },
  ] })
  expect(result.display).toMatch(/100\s*积分\s*·\s*已过期/)
  expect(result.display).toMatch(/3\s*积分\s*·\s*可用/)
  expect(result.display).not.toMatch(/100\s*积分\s*·\s*可用|可用[^；]*100/)
})

test("balance is the USD amount alone; website identity and plan head the card without repeating in notes", async () => {
  const email = "long-website-fixture@example.invalid"
  const plan = "Fixture Website Plan"
  const pack = { id: 301, comment: "fixture-booster-detail", credits: 9, isUsed: false, expiresAt: "2099-01-01T00:00:00Z" }
  fakeUsage({
    "/api/me": { email },
    "/api/subscriptions": { subscriptions: [{ planName: plan }] },
    "/api/usd-account": { account: { balanceUsd: 12.34 } },
    "/api/credits/booster-packs": { boosterPacks: [pack] },
    "/api/tickets?page=1&limit=20": { tickets: [{ title: "请求重置积分", createdAt: new Date().toISOString(), status: "CLOSED" }] },
  })
  const result = await usage(withJwt)
  expect(result.balance).toBe("$12.34")
  const balance = result.windows[0].display
  // magpie shows the first two parts; its title keeps the third in full.
  expect(balance.split(" · ").length).toBe(3)
  expect(balance.split(" · ")[1]).toBe("5/时，未重置")
  expect(result.user).toBe(email)
  expect(result.plan).toBe(plan)
  expect(balance).not.toContain(email)
  for (const marker of ["加油包", "今日已申请"]) {
    expect(balance.indexOf(marker)).toBeGreaterThanOrEqual(0)
  }
  expect(balance).toMatch(/加油包[^；]*可用\s*1/)
  expect(balance).not.toContain(plan)
  expect(balance).toContain("工单已关闭")
  expect(balance).not.toMatch(/今日已重置|已到账/)
  const details = _internal.summarizeBoosters({ boosterPacks: [pack] }).display
  expect(details).toContain(pack.comment)
  expect(details).toContain("9 积分")
})

test("compact booster counts include every pack beyond the five detailed rows and separate all states", () => {
  const packs = [
    ...[401, 402, 403, 404, 405].map((id) => ({ id, credits: 3, isUsed: false, expiresAt: "2099-01-01T00:00:00Z" })),
    { id: 406, credits: 100, isUsed: false, expiresAt: "2020-01-01T00:00:00Z" },
    { id: 407, credits: 100, isUsed: true, expiresAt: "2020-01-01T00:00:00Z" },
    { id: 408, credits: 100, isUsed: false },
    { id: 409, credits: 100, isUsed: false, expiresAt: "not-a-date" },
  ]
  const summary = _internal.summarizeBoosters({ boosterPacks: packs })
  expect(summary.count).toBe(packs.length)
  expect(summary.compact).toMatch(/可用\s*5(?:\D|$)/)
  expect(summary.compact).toMatch(/已过期\s*1(?:\D|$)/)
  expect(summary.compact).toMatch(/已用\s*1(?:\D|$)/)
  expect(summary.compact).toMatch(/有效期未知\s*2(?:\D|$)/)
  expect(summary.display).toContain("补充包 #401")
  expect(summary.display).toContain("3 积分")
  expect(summary.compact).not.toContain(" · ")
  expect(summary.compact.startsWith("可用 ")).toBe(true)
})

for (const [status, label] of [
  ["WAITING_FOR_SUPPORT", "工单等待客服"], ["WAITING_FOR_USER", "工单等待用户回复"],
  ["CLOSED", "工单已关闭"], ["UNRECOGNIZED", "工单状态未知"],
]) {
  test(`official ticket state ${status} remains separate from credit arrival`, async () => {
    const email = "website@example.invalid"
    fakeUsage({ "/api/me": { email }, "/api/tickets?page=1&limit=20": {
      tickets: [{ category: { key: "REQUEST_TO_REFILL_CREDIT" }, createdAt: new Date().toISOString(), status }],
    } })
    const display = (await usage(withJwt)).windows[0].display
    expect(display.split(" · ")[1]).toBe("5/时，未重置")
    expect(display).toContain(label)
    expect(display).not.toContain(email)
    expect(display).not.toMatch(/已到账|今日已重置|审批通过|申请失败/)
  })
}

test("website credits head the card and a different API-key account is identified separately", async () => {
  fakeUsage({ [statusPath]: { balance: 2, creditCap: 100, refillRate: 5,
    timeMultiplier: { value: 0.8 }, user: { id: 101, email: "key-owner@example.invalid" } },
    "/api/me": { email: "different-website@example.invalid" } })
  const result = await usage(withJwt)
  expect(result.user).toBe("different-website@example.invalid")
  expect(result.windows[0].display).toContain("API key 账户 key-owner@example.invalid")
  expect(result.windows[0].display).not.toContain("different-website@example.invalid")
  expect(result.windows[0].display).toContain("5/时")
  expect(result.signIn).toBe("kept")
})

test("a website account matching the key's email names the plan instead of repeating the email", async () => {
  const email = "key-owner@example.invalid"
  fakeUsage({ [statusPath]: { balance: 2, creditCap: 100, user: { email } },
    "/api/me": { email: "Key-Owner@example.invalid" },
    "/api/subscriptions": { subscriptions: [{ planName: "GAC Max" }] },
    "/api/usd-account": { account: { balanceUsd: 3 } } })
  const result = await usage(withJwt)
  expect(result.user.toLowerCase()).toBe(email)
  expect(result.plan).toBe("GAC Max")
  expect(result.balance).toBe("$3")
  expect(result.windows[0].display).not.toContain(email)
})

test("website identity keeps naming website credits when the optional statusline fails", async () => {
  fakeUsage({ [statusPath]: Response.json({}, { status: 401 }), "/api/me": { email: "website@example.invalid" } })
  const result = await usage(withJwt)
  expect(result.user).toBe("website@example.invalid")
  expect(result.balance).toBeUndefined()
  expect(result.error).toBeUndefined()
  expect(result.windows[0].display).toContain("2 / 100")
  expect(result.signIn).toBe("kept")
})

test("a rejected credit query cannot turn ticket notes or website USD into a balance that hides the error", async () => {
  for (const account of [null, { balanceUsd: 3 }]) {
    fakeUsage({
      [creditPath]: Response.json({}, { status: 401 }),
      "/api/me": { user: { email: "website@example.invalid" } },
      "/api/subscriptions": { subscriptions: [{ planName: "GAC Max" }] },
      "/api/usd-account": { account },
      "/api/tickets?page=1&limit=20": { tickets: [{ title: "请求重置积分", createdAt: new Date().toISOString(), status: "CLOSED" }] },
    })
    const result = await usage(withJwt)
    // Magpie renders balance before error when there are no quota windows.
    expect(result.balance).toBeUndefined()
    expect(result.windows).toEqual([])
    expect(result.error).toContain("HTTP 401")
    expect(result.signIn).toBe("kept")
  }
})
