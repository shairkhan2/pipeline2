import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteSecret,
  getSecret,
  getSecretMeta,
  maskSecretHint,
  putSecret,
  scrubSecrets,
  secretsFilePath,
} from "../src/config/secretStore.js";
import {
  createPkceChallenge,
  exchangePkceToken,
  getStagesConfig,
  listProviders,
  mintVertexAccessToken,
  putStagesConfig,
  upsertProvider,
  validateProviderUrl,
} from "../src/config/studioConfig.js";
import * as llm from "../src/llm/client.js";
import { _resetSetupForTests } from "../src/player/setup.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("Creative Studio Backend: Secret Vault, Providers, OAuth/Vertex, Stage Routing & HTTP API", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = makeTempDir("studio-backend-test-");
    for (const k of [
      "MANHWA_OUT_DIR",
      "MANHWA_MASTER_KEY",
      "MANHWA_SETUP_MODE",
      "MANHWA_SETUP_TOKEN",
      "PLAYER_HTPASSWD",
      "PLAYER_SECRET_FILE",
      "PLAYER_TEMP_USERS",
      "PLAYER_COOKIE_SECURE",
    ]) {
      savedEnv[k] = process.env[k];
    }
    process.env.MANHWA_OUT_DIR = tmpDir;
    delete process.env.MANHWA_MASTER_KEY;
    delete process.env.MANHWA_SETUP_MODE;
    delete process.env.MANHWA_SETUP_TOKEN;
    _resetSetupForTests();
    llm._resetSnapshotForTests();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetSetupForTests();
    llm._resetSnapshotForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores secrets with mode 0o600, encrypts with AES-256-GCM when MANHWA_MASTER_KEY is set, and scrubs leaked tokens", () => {
    process.env.MANHWA_MASTER_KEY = "test-master-passphrase-for-aes-gcm";
    const meta = putSecret("provider:xai", "xai-supersecretkey1234567890abcd", tmpDir);
    expect(meta.hasSecret).toBe(true);
    expect(meta.hint).toContain("abcd");
    expect(meta.hint).not.toContain("supersecretkey");

    const file = secretsFilePath(tmpDir);
    const st = fs.statSync(file);
    expect(st.mode & 0o777).toBe(0o600);

    const rawDisk = fs.readFileSync(file, "utf8");
    expect(rawDisk).toContain("enc:v1:");
    expect(rawDisk).not.toContain("supersecretkey1234567890abcd");

    expect(getSecret("provider:xai", tmpDir)).toBe("xai-supersecretkey1234567890abcd");
    expect(getSecretMeta("provider:xai", tmpDir).hasSecret).toBe(true);

    expect(deleteSecret("provider:xai", tmpDir)).toBe(true);
    expect(getSecret("provider:xai", tmpDir)).toBeNull();
    expect(getSecretMeta("provider:xai", tmpDir).hasSecret).toBe(false);

    expect(maskSecretHint("short")).toBe("****");
    const scrubbed = scrubSecrets(
      "Authorization: Bearer sk-or-v1-998877665544332211 key=xai-abcdef1234567890 AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz",
    );
    expect(scrubbed).not.toContain("sk-or-v1-998877665544332211");
    expect(scrubbed).not.toContain("xai-abcdef1234567890");
    expect(scrubbed).not.toContain("AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz");
  });

  it("enforces SSRF rules on provider URLs (blocks cloud metadata & private IPs unless allowPrivateNetwork)", () => {
    expect(() => validateProviderUrl("http://169.254.169.254/latest/meta-data/")).toThrow(/metadata|link-local/i);
    expect(() => validateProviderUrl("http://169.254.169.254/latest/meta-data/", { allowPrivateNetwork: true })).toThrow(
      /metadata|link-local/i,
    );
    expect(() => validateProviderUrl("http://metadata.google.internal/computeMetadata/v1/")).toThrow(/metadata/i);
    expect(() => validateProviderUrl("file:///etc/passwd")).toThrow(/protocol/i);
    expect(() => validateProviderUrl("http://127.0.0.1:11434/v1", { allowPrivateNetwork: false })).toThrow(
      /allowPrivateNetwork/i,
    );
    expect(() => validateProviderUrl("http://192.168.1.50:8000/v1", { allowPrivateNetwork: false })).toThrow(
      /allowPrivateNetwork/i,
    );
    expect(validateProviderUrl("http://127.0.0.1:11434/v1", { allowPrivateNetwork: true })).toBe(
      "http://127.0.0.1:11434/v1",
    );
    expect(validateProviderUrl("https://api.x.ai/v1/")).toBe("https://api.x.ai/v1");
  });

  it("supports OAuth PKCE challenge/exchange and GCP Vertex AI Service Account RS256 JWT minting", async () => {
    const pkce = createPkceChallenge({
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      redirectUri: "http://localhost:1455/auth/callback",
    });
    expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(32);
    expect(pkce.codeChallenge).toBe(
      crypto.createHash("sha256").update(pkce.codeVerifier).digest("base64url"),
    );
    expect(pkce.authorizeUrl).toContain("code_challenge=");

    const exchanged = await exchangePkceToken({
      providerId: "codex-oauth",
      code: "auth_code_xyz",
      codeVerifier: pkce.codeVerifier,
      outDir: tmpDir,
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            access_token: "codex_access_tok_1234567890",
            refresh_token: "codex_refresh_tok_9876543210",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    expect(exchanged.accessToken).toBe("codex_access_tok_1234567890");
    expect(getSecretMeta("provider:codex-oauth", tmpDir).hasSecret).toBe(true);

    // Generate temporary RSA keypair for Vertex Service Account RS256 JWT signing test
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pemPrivate = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const saJson = JSON.stringify({
      type: "service_account",
      project_id: "studio-vertex-proj",
      client_email: "studio-bot@studio-vertex-proj.iam.gserviceaccount.com",
      private_key: pemPrivate,
      token_uri: "https://oauth2.googleapis.com/token",
    });

    const vertexRes = await mintVertexAccessToken(saJson, {
      nowSec: 1700000000,
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        const bodyParams = new URLSearchParams(String(init?.body ?? ""));
        const assertion = bodyParams.get("assertion") || "";
        const [h, c, s] = assertion.split(".");
        const verifier = crypto.createVerify("RSA-SHA256");
        verifier.update(`${h}.${c}`);
        verifier.end();
        expect(verifier.verify(publicKey, s!, "base64url")).toBe(true);
        return new Response(
          JSON.stringify({ access_token: "ya29.vertex_minted_token_abcd", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    expect(vertexRes.accessToken).toBe("ya29.vertex_minted_token_abcd");
    expect(vertexRes.projectId).toBe("studio-vertex-proj");
  });

  it("dispatches llm.call() through dynamic Studio providers and stage routing (including Anthropic messages protocol)", async () => {
    upsertProvider(
      {
        id: "claude-studio",
        label: "Claude Studio",
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-oat01-secret-token-9999",
        models: [{ id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", capabilities: { vision: true, writer: true, json: true, reasoning: false, streaming: true, tts: false } }],
      },
      tmpDir,
    );

    putStagesConfig(
      {
        writer: {
          chain: ["claude-studio:claude-sonnet-4-20250514"],
          concurrency: 2,
          temperature: 0.5,
        },
      },
      tmpDir,
    );
    llm._resetSnapshotForTests();

    const seenRequests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      seenRequests.push({ url, headers, body });
      return new Response(
        JSON.stringify({
          id: "msg_01",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Translated Anthropic studio response!" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const reply = await llm.call(
        [
          { role: "system", content: "You are a manhwa narrator." },
          { role: "user", content: "Write opening hook." },
        ],
        { stage: "writer" },
      );
      expect((reply as any).choices?.[0]?.message?.content).toBe("Translated Anthropic studio response!");
      expect(seenRequests.length).toBe(1);
      expect(seenRequests[0]!.url).toBe("https://api.anthropic.com/v1/messages");
      expect(seenRequests[0]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
      expect(seenRequests[0]!.body.system).toBe("You are a manhwa narrator.");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("serves /api/setup/* bootstrap wizard and /api/studio/* CRUD with write-only secrets and privilege/CSRF guards", async () => {
    const htpasswdFile = path.join(tmpDir, ".htpasswd");
    const secretFile = path.join(tmpDir, ".auth_secret");
    const tempUsersFile = path.join(tmpDir, ".temp_users.json");
    process.env.PLAYER_HTPASSWD = htpasswdFile;
    process.env.PLAYER_SECRET_FILE = secretFile;
    process.env.PLAYER_TEMP_USERS = tempUsersFile;
    process.env.PLAYER_COOKIE_SECURE = "false";
    process.env.MANHWA_SETUP_MODE = "1";
    process.env.MANHWA_SETUP_TOKEN = "bootstrap-token-12345";

    const serverMod = await import("../src/player/server.js");
    const srv: http.Server = serverMod.createPlayerServer();
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. Setup state is open before admin creation
      const stateRes = await fetch(`${base}/api/setup/state`);
      expect(stateRes.status).toBe(200);
      const stateBody = (await stateRes.json()) as any;
      expect(stateBody.needsSetup).toBe(true);
      expect(stateBody.hasAdmin).toBe(false);

      // 2. Reject invalid setup token
      const badTokenRes = await fetch(`${base}/api/setup/admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "strongpassword123", setupToken: "wrong" }),
      });
      expect(badTokenRes.status).toBe(403);

      // 3. Create admin account with valid setup token
      const adminRes = await fetch(`${base}/api/setup/admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          password: "strongpassword123",
          setupToken: "bootstrap-token-12345",
        }),
      });
      expect(adminRes.status).toBe(200);
      const setCookie = adminRes.headers.get("set-cookie") || "";
      expect(setCookie).toContain("sr_session=");
      const adminCookie = setCookie.split(";")[0]!;

      // Fetch CSRF token from /api/session
      const sessRes = await fetch(`${base}/api/session`, {
        headers: { Cookie: adminCookie },
      });
      expect(sessRes.status).toBe(200);
      const sessBody = (await sessRes.json()) as any;
      expect(sessBody.user).toBe("admin");
      expect(sessBody.privileged).toBe(true);
      const csrfToken = sessBody.csrfToken as string;

      // 4. Add xAI Grok provider via POST /api/studio/providers
      const createProvRes = await fetch(`${base}/api/studio/providers`, {
        method: "POST",
        headers: {
          Cookie: adminCookie,
          Origin: base,
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "xai",
          preset: "xai",
          apiKey: "xai-live-secret-key-99887766",
        }),
      });
      expect(createProvRes.status).toBe(201);
      const createProvBody = (await createProvRes.json()) as any;
      expect(createProvBody.provider.id).toBe("xai");
      expect(createProvBody.provider.auth.hasSecret).toBe(true);
      expect(createProvBody.provider.auth.secretHint).toContain("7766");
      expect(JSON.stringify(createProvBody)).not.toContain("xai-live-secret-key-99887766");

      // 5. Add a Docker Cloud Sandbox render node via POST /api/studio/nodes
      const createNodeRes = await fetch(`${base}/api/studio/nodes`, {
        method: "POST",
        headers: {
          Cookie: adminCookie,
          Origin: base,
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "sbx-eu",
          label: "Cloud Sandbox EU",
          kind: "docker-sbx",
          box: "manhwa-render-eu",
          template: "manhwa-render-arm",
          slots: 2,
        }),
      });
      expect(createNodeRes.status).toBe(201);
      const createNodeBody = (await createNodeRes.json()) as any;
      expect(createNodeBody.node.id).toBe("sbx-eu");
      expect(createNodeBody.node.box).toBe("manhwa-render-eu");

      // 6. Complete setup and verify needsSetup becomes false
      const completeRes = await fetch(`${base}/api/setup/complete`, {
        method: "POST",
        headers: {
          Cookie: adminCookie,
          Origin: base,
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ csrfToken }),
      });
      expect(completeRes.status).toBe(200);
      const stateAfter = (await (await fetch(`${base}/api/setup/state`)).json()) as any;
      expect(stateAfter.needsSetup).toBe(false);

      // 7. Verify temporary viewer account gets 403 on /api/studio/* mutations and /api/agy
      const viewerHash = serverMod.apr1("viewerpass123", "saltsalt");
      fs.appendFileSync(htpasswdFile, `guest:${viewerHash}\n`);
      fs.writeFileSync(tempUsersFile, JSON.stringify({ guest: Date.now() + 3600_000 }));
      const guestCookie = `sr_session=${encodeURIComponent(serverMod.makeCookie("guest"))}`;
      const guestSess = (await (
        await fetch(`${base}/api/session`, { headers: { Cookie: guestCookie } })
      ).json()) as any;
      expect(guestSess.privileged).toBe(false);

      const guestPostProv = await fetch(`${base}/api/studio/providers`, {
        method: "POST",
        headers: {
          Cookie: guestCookie,
          Origin: base,
          "X-CSRF-Token": guestSess.csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: "openai", preset: "openai", apiKey: "sk-test1234567890" }),
      });
      expect(guestPostProv.status).toBe(403);

      const guestAgy = await fetch(`${base}/api/agy`, {
        headers: { Cookie: guestCookie },
      });
      expect(guestAgy.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
