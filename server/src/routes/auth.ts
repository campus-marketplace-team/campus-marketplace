import { Router } from "express";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { getAuthConfig } from "../auth/config.js";
import { isSchoolEmail, normalizeEmail, sendVerificationEmail } from "../auth/email.js";
import { requireAuth } from "../auth/middleware.js";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../auth/password.js";
import { signSessionToken, signVerifyEmailToken, verifyVerifyEmailToken } from "../auth/tokens.js";

export const authRouter = Router();

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128; // caps hashing cost per request

const publicUser = { id: true, email: true, displayName: true, isAdmin: true, emailVerifiedAt: true } as const;

async function sendVerificationLink(userId: string, email: string) {
  const token = await signVerifyEmailToken(userId, email);
  const link = `${getAuthConfig().apiPublicUrl}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  sendVerificationEmail(email, link);
}

// POST /api/auth/signup  { email, password, displayName }
authRouter.post("/signup", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";

  if (!email) {
    res.status(400).json({ error: "Enter a valid email address" });
    return;
  }
  if (!isSchoolEmail(email)) {
    const domains = getAuthConfig().allowedEmailDomains.join(", ");
    res.status(400).json({ error: `Sign up with your school email (${domains})` });
    return;
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    res.status(400).json({ error: `Password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters` });
    return;
  }
  if (!displayName || displayName.length > 50) {
    res.status(400).json({ error: "Display name must be 1-50 characters" });
    return;
  }

  try {
    const user = await prisma.user.create({
      data: { email, displayName, passwordHash: await hashPassword(password) },
      select: publicUser,
    });
    await sendVerificationLink(user.id, user.email);
    res.status(201).json({ user, message: "Account created. Check your email for a verification link." });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      res.status(409).json({ error: "An account with that email already exists" });
      return;
    }
    throw err;
  }
});

// GET /api/auth/verify-email?token=...   (the link from the verification email)
authRouter.get("/verify-email", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const claims = token ? await verifyVerifyEmailToken(token) : null;
  const user = claims
    ? await prisma.user.findUnique({ where: { id: claims.userId }, select: { email: true, emailVerifiedAt: true } })
    : null;

  if (!claims || !user || user.email !== claims.email) {
    res.status(400).json({ error: "This verification link is invalid or has expired" });
    return;
  }
  if (!user.emailVerifiedAt) {
    await prisma.user.update({ where: { id: claims.userId }, data: { emailVerifiedAt: new Date() } });
  }
  res.json({ ok: true, message: "Email verified. You can log in now." });
});

// POST /api/auth/resend-verification  { email }
// Always answers the same way so it can't be used to discover which emails have accounts.
authRouter.post("/resend-verification", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (email) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, emailVerifiedAt: true } });
    if (user && !user.emailVerifiedAt) await sendVerificationLink(user.id, email);
  }
  res.json({ ok: true, message: "If that account exists and isn't verified yet, a new link has been sent." });
});

// POST /api/auth/login  { email, password }  ->  { token, user }
authRouter.post("/login", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === "string" ? req.body.password.slice(0, MAX_PASSWORD) : "";

  const user = email
    ? await prisma.user.findUnique({ where: { email }, select: { ...publicUser, passwordHash: true } })
    : null;

  // Same message and similar timing for "no such user" and "wrong password".
  if (!user?.passwordHash) {
    await burnPasswordCheck(password);
    res.status(401).json({ error: "Incorrect email or password" });
    return;
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    res.status(401).json({ error: "Incorrect email or password" });
    return;
  }
  if (!user.emailVerifiedAt) {
    res.status(403).json({ error: "Verify your email before logging in", code: "EMAIL_NOT_VERIFIED" });
    return;
  }

  const { passwordHash: _omit, ...safeUser } = user;
  res.json({ token: await signSessionToken(user.id), user: safeUser });
});

// GET /api/auth/me  (protected) -> the logged-in user
authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// PUT /api/auth/me/paypal-email  (protected)  { paypalEmail, password }  ->  { paypalEmail }
// Where seller payouts go; payouts wait until it's set. null or "" clears it. Needs the
// current password too, so a stolen session token alone can't redirect someone's payouts.
authRouter.put("/me/paypal-email", requireAuth, async (req, res) => {
  const raw = req.body?.paypalEmail;
  const clearing = raw === null || raw === "";
  const paypalEmail = clearing ? null : normalizeEmail(raw);
  const password = typeof req.body?.password === "string" ? req.body.password.slice(0, MAX_PASSWORD) : "";

  if (!clearing && !paypalEmail) {
    res.status(400).json({ error: "Enter a valid PayPal email address" });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { passwordHash: true } });
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    if (!user?.passwordHash) await burnPasswordCheck(password);
    res.status(401).json({ error: "Incorrect password" });
    return;
  }
  const updated = await prisma.user.update({ where: { id: req.user!.id }, data: { paypalEmail }, select: { paypalEmail: true } });
  res.json(updated);
});
