import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signSessionToken, signVerifyEmailToken } from "../src/auth/tokens.js";
import { TEST_USER_EMAIL_PREFIX } from "../src/testUsers.js";
import { type Api, TEST_PASSWORD, cleanup, createTestUser, login, prisma, schoolEmail, signupEmail, startApi } from "./helpers/api.js";

let api: Api;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await cleanup();
  await api.close();
  await prisma.$disconnect();
});

describe("POST /api/auth/signup", () => {
  it("rejects a non-school email and creates no user", async () => {
    const email = `apitest.${Date.now()}@gmail.com`;
    const res = await api.call("POST", "/auth/signup", { json: { email, password: TEST_PASSWORD, displayName: "Nope" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/school email/i);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("rejects a lookalike domain that only ends with the school domain's text", async () => {
    const school = schoolEmail("x").split("@")[1];
    const email = `apitest.${Date.now()}@not${school}`;
    const res = await api.call("POST", "/auth/signup", { json: { email, password: TEST_PASSWORD, displayName: "Nope" } });
    expect(res.status).toBe(400);
  });

  it("rejects an address reserved for test users (the worker skips their data) and creates no user", async () => {
    const email = schoolEmail("reserved");
    expect(email.startsWith(TEST_USER_EMAIL_PREFIX)).toBe(true);
    for (const attempt of [email, `  ${email.toUpperCase()} `]) {
      const res = await api.call("POST", "/auth/signup", { json: { email: attempt, password: TEST_PASSWORD, displayName: "Nope" } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/can't be used to sign up/);
    }
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("accepts a school email, unverified, and never returns the password hash", async () => {
    const email = signupEmail("signup");
    const res = await api.call("POST", "/auth/signup", { json: { email, password: TEST_PASSWORD, displayName: "New Student" } });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email, displayName: "New Student", emailVerifiedAt: null });
    expect(res.body.user).not.toHaveProperty("passwordHash");
  });

  it("rejects a second account with the same email", async () => {
    const user = await createTestUser("dupe", { email: signupEmail("dupe") });
    const res = await api.call("POST", "/auth/signup", { json: { email: user.email, password: TEST_PASSWORD, displayName: "Again" } });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/auth/login", () => {
  it("returns a token that works on a protected route", async () => {
    const user = await createTestUser("login");
    const res = await api.call("POST", "/auth/login", { json: { email: user.email, password: TEST_PASSWORD } });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user).toMatchObject({ id: user.id, email: user.email });
    expect(res.body.user).not.toHaveProperty("passwordHash");

    const me = await api.call("GET", "/auth/me", { token: res.body.token });
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);
  });

  it("ignores case and spaces in the email", async () => {
    const user = await createTestUser("case");
    const res = await api.call("POST", "/auth/login", { json: { email: `  ${user.email.toUpperCase()} `, password: TEST_PASSWORD } });
    expect(res.status).toBe(200);
  });

  it("gives the same 401 for a wrong password and an unknown email", async () => {
    const user = await createTestUser("wrongpw");
    const wrong = await api.call("POST", "/auth/login", { json: { email: user.email, password: "not-the-password" } });
    const unknown = await api.call("POST", "/auth/login", { json: { email: schoolEmail("nobody"), password: TEST_PASSWORD } });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("refuses an unverified user until they open the verification link", async () => {
    const user = await createTestUser("unverified", { verified: false });
    const before = await api.call("POST", "/auth/login", { json: { email: user.email, password: TEST_PASSWORD } });
    expect(before.status).toBe(403);
    expect(before.body.code).toBe("EMAIL_NOT_VERIFIED");

    const token = await signVerifyEmailToken(user.id, user.email);
    const verify = await api.call("GET", `/auth/verify-email?token=${encodeURIComponent(token)}`);
    expect(verify.status).toBe(200);

    expect(await login(api, user.email)).toEqual(expect.any(String));
  });
});

describe("unauthenticated requests", () => {
  const protectedRoutes: Array<[string, string]> = [
    ["GET", "/auth/me"],
    ["POST", "/listings"],
    ["PATCH", "/listings/00000000-0000-0000-0000-000000000000"],
    ["POST", "/listings/00000000-0000-0000-0000-000000000000/sold"],
    ["POST", "/listings/00000000-0000-0000-0000-000000000000/photos"],
    ["DELETE", "/listings/00000000-0000-0000-0000-000000000000/photos/x.jpg"],
    ["GET", "/chats"],
    ["GET", "/chats/00000000-0000-0000-0000-000000000000/messages"],
    ["POST", "/chats/00000000-0000-0000-0000-000000000000/messages"],
  ];

  it.each(protectedRoutes)("%s %s without a token -> 401", async (method, path) => {
    const res = await api.call(method, path, { json: method === "GET" ? undefined : {} });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed token", async () => {
    const res = await api.call("GET", "/auth/me", { token: "not-a-real-token" });
    expect(res.status).toBe(401);
  });

  it("rejects a valid token once the user is no longer verified", async () => {
    const user = await createTestUser("unverified-token", { verified: false });
    const res = await api.call("GET", "/auth/me", { token: await signSessionToken(user.id) });
    expect(res.status).toBe(401);
  });

  it("doesn't create a listing without a token", async () => {
    const title = `apitest no-auth ${Date.now()}`;
    const res = await api.call("POST", "/listings", {
      json: { title, description: "x", category: "OTHER", priceCents: 500 },
    });
    expect(res.status).toBe(401);
    expect(await prisma.listing.count({ where: { title } })).toBe(0);
  });
});
