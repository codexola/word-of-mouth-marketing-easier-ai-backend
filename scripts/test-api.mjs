const API = process.env.API_URL || "http://localhost:4000/api";
const DEV_EMAIL = process.env.DEVELOPER_EMAIL;
const DEV_PASSWORD = process.env.DEVELOPER_PASSWORD;

if (!DEV_EMAIL || !DEV_PASSWORD) {
  console.error("Set DEVELOPER_EMAIL and DEVELOPER_PASSWORD in the environment.");
  process.exit(1);
}
let token = "";
let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log(`  [OK] ${name}`);
}

function fail(name, err) {
  failed++;
  console.error(`  [FAIL] ${name}: ${err}`);
}

async function req(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

console.log("=== API テスト開始 ===\n");

try {
  const res = await fetch("http://localhost:4000/api/health");
  const data = await res.json();
  if (res.ok && data.status === "ok") ok("GET /api/health");
  else fail("GET /api/health", JSON.stringify(data));
} catch (e) {
  fail("GET /api/health", e.message);
}

try {
  const { status, data } = await req("POST", "/auth/login", {
    email: DEV_EMAIL,
    password: DEV_PASSWORD,
  });
  if (status === 200 && data.token) {
    token = data.token;
    ok("POST /auth/login (developer)");
  } else fail("POST /auth/login", JSON.stringify(data));
} catch (e) {
  fail("POST /auth/login", e.message);
}

try {
  const { status, data } = await req("GET", "/auth/me");
  if (status === 200 && data.user?.email) ok("GET /auth/me");
  else fail("GET /auth/me", JSON.stringify(data));
} catch (e) {
  fail("GET /auth/me", e.message);
}

try {
  const { status, data } = await req("POST", "/posts/repair-errors");
  if (status === 200 && typeof data.repaired === "number") ok("POST /posts/repair-errors");
  else fail("POST /posts/repair-errors", JSON.stringify(data));
} catch (e) {
  fail("POST /posts/repair-errors", e.message);
}

try {
  const { status, data } = await req("GET", "/posts/stats");
  if (status === 200 && typeof data.pendingReview === "number") ok("GET /posts/stats");
  else fail("GET /posts/stats", JSON.stringify(data));
} catch (e) {
  fail("GET /posts/stats", e.message);
}

try {
  const { status, data } = await req("POST", "/posts/manual", {
    region: "テスト市",
    serviceType: "屋根点検",
    workDescription: "APIテスト用",
    memo: "自動テスト",
  });
  if (status === 201 && data.id) {
    ok("POST /posts/manual");
    if (data.status !== "ERROR") ok("POST /posts/manual → not ERROR");
    else fail("POST /posts/manual status", `status=${data.status}`);
  } else fail("POST /posts/manual", JSON.stringify(data));
} catch (e) {
  fail("POST /posts/manual", e.message);
}

try {
  const { status, data } = await req("GET", "/posts");
  if (status === 200 && Array.isArray(data.items)) ok("GET /posts");
  else fail("GET /posts", JSON.stringify(data));
} catch (e) {
  fail("GET /posts", e.message);
}

try {
  const { status, data } = await req("GET", "/settings");
  if (status === 200 && data.serviceAreas) ok("GET /settings");
  else fail("GET /settings", JSON.stringify(data));
} catch (e) {
  fail("GET /settings", e.message);
}

try {
  const { status, data } = await req("PUT", "/settings", {
    emailAutoSendEnabled: true,
    autoRetryEnabled: true,
  });
  if (status === 200) ok("PUT /settings (email/retry toggles)");
  else fail("PUT /settings", JSON.stringify(data));
} catch (e) {
  fail("PUT /settings", e.message);
}

try {
  const { status, data } = await req("GET", "/posts/approved");
  if (status === 200 && Array.isArray(data.items)) ok("GET /posts/approved");
  else fail("GET /posts/approved", JSON.stringify(data));
} catch (e) {
  fail("GET /posts/approved", e.message);
}

try {
  const { status, data } = await req("GET", "/reviews");
  if (status === 200 && Array.isArray(data.items)) ok("GET /reviews");
  else fail("GET /reviews", JSON.stringify(data));
} catch (e) {
  fail("GET /reviews", e.message);
}

try {
  const { status, data } = await req("POST", "/reviews", {
    customerName: "テスト顧客",
    completionDate: "2026-06-01",
    customerEmail: "test@example.com",
  });
  if (status === 201 && data.id) {
    ok("POST /reviews (email only)");
    if (data.sendStatus === "SCHEDULED") ok("POST /reviews → SCHEDULED for email");
    else fail("POST /reviews sendStatus", `sendStatus=${data.sendStatus}`);
  } else fail("POST /reviews", JSON.stringify(data));
} catch (e) {
  fail("POST /reviews", e.message);
}

try {
  const { status } = await req("POST", "/auth/login", {
    email: DEV_EMAIL,
    password: "wrong-password",
  });
  if (status === 401) ok("POST /auth/login (invalid password → 401)");
  else fail("POST /auth/login invalid", `status=${status}`);
} catch (e) {
  fail("POST /auth/login invalid", e.message);
}

try {
  const { status } = await req("POST", "/auth/login", {
    email: "admin@example.com",
    password: "admin123",
  });
  if (status === 401) ok("POST /auth/login (legacy admin@example.com → 401)");
  else fail("POST /auth/login legacy", `status=${status} (expected 401)`);
} catch (e) {
  fail("POST /auth/login legacy", e.message);
}

try {
  const { status, data } = await req("GET", "/gbp/status");
  if (status === 200 && typeof data.oauthConfigured === "boolean") ok("GET /gbp/status");
  else fail("GET /gbp/status", JSON.stringify(data));
} catch (e) {
  fail("GET /gbp/status", e.message);
}

try {
  const { status, data } = await req("GET", "/line/status");
  if (status === 200 && typeof data.configured === "boolean") ok("GET /line/status");
  else fail("GET /line/status", JSON.stringify(data));
} catch (e) {
  fail("GET /line/status", e.message);
}

console.log(`\n=== 結果: ${passed} 成功 / ${failed} 失敗 ===`);
process.exit(failed > 0 ? 1 : 0);
