import { describe, expect, test } from "bun:test";
import {
  assertSessionSecretIsStrong,
  enabledFeatureNames,
  googleWritesAllowed,
  hasProfile,
  loadConfig,
  parseAllowedUsers,
  signinHasAddress,
} from "./config";

describe("hasProfile", () => {
  test("matches whole comma-delimited tokens, ignoring surrounding space", () => {
    expect(hasProfile("cloudflared,google,search,codex,claude", "google")).toBe(true);
    expect(hasProfile("cloudflared, search , codex", "search")).toBe(true);
    expect(hasProfile("codex", "codex")).toBe(true);
  });

  test("does not match a token inside a longer word", () => {
    // The list is one shared namespace, so exact tokens matter: a profile
    // named `searchy` must not light up the web tools, and `research` is not
    // `search` either way.
    expect(hasProfile("searchy", "search")).toBe(false);
    expect(hasProfile("research,codexy", "codex")).toBe(false);
    expect(hasProfile("cloudflaredx", "cloudflared")).toBe(false);
  });

  test("an empty list carries nothing", () => {
    expect(hasProfile("", "local")).toBe(false);
    expect(hasProfile(",,", "google")).toBe(false);
  });
});

describe("loadConfig features", () => {
  const base = {
    PUBLIC_ORIGIN: "http://localhost:8090",
    LETTA_APP_SERVER_URL: "ws://127.0.0.1:4500",
    SESSION_SECRET: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p67",
  };

  function withEnv(extra: Record<string, string | undefined>, run: () => void): void {
    const saved = { ...process.env };
    try {
      for (const [key, value] of Object.entries(extra)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      run();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }

  test("no profile list means no feature tokens — everything off", () => {
    withEnv({ ...base, LETTA_MODE: undefined }, () => {
      expect(loadConfig().features).toEqual({
        web: false,
        google: false,
        codex: false,
        claude: false,
        pi: false,
        telegram: false,
      });
    });
  });

  test("exact tokens flip exactly the features they name", () => {
    withEnv({ ...base, LETTA_MODE: "google,search" }, () => {
      expect(loadConfig().features).toEqual({
        web: true,
        google: true,
        codex: false,
        claude: false,
        pi: false,
        telegram: false,
      });
    });
    withEnv({ ...base, LETTA_MODE: "codex,claude,pi" }, () => {
      expect(loadConfig().features).toEqual({
        web: false,
        google: false,
        codex: true,
        claude: true,
        pi: true,
        telegram: false,
      });
    });
    withEnv({ ...base, LETTA_MODE: "telegram" }, () => {
      expect(loadConfig().features.telegram).toBe(true);
    });
  });

  test("lookalikes are not features", () => {
    withEnv({ ...base, LETTA_MODE: "searchy,googleplex,codex,telegramm" }, () => {
      expect(loadConfig().features).toEqual({
        web: false,
        google: false,
        codex: true,
        claude: false,
        pi: false,
        telegram: false,
      });
    });
  });

  test("the profile list no longer decides who signs in", () => {
    // The token used to be the whole answer: cloudflared meant Access was the
    // gate. It now only has to agree with `ACCESS`, and `SIGNIN` is its own call.
    withEnv(
      {
        ...base,
        LETTA_MODE: "cloudflared,codex",
        ALLOWED_USERS: "me@example.com",
        CF_ACCESS_TEAM_DOMAIN: "acme",
        CF_ACCESS_AUD: "aud",
      },
      () => {
        const config = loadConfig();
        expect(config.access).toBe("cloudflared");
        expect(config.signin).toBe("cf-access");
        expect(config.features.codex).toBe(true);
      },
    );
    withEnv({ ...base, LETTA_MODE: "cloudflaredx" }, () => {
      expect(loadConfig().access).toBe("lan");
    });
  });
});

describe("loadConfig access and sign-in", () => {
  const base = {
    PUBLIC_ORIGIN: "https://lettuce.example.com",
    LETTA_APP_SERVER_URL: "ws://127.0.0.1:4500",
    SESSION_SECRET: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p67",
  };
  const cf = {
    CF_ACCESS_TEAM_DOMAIN: "acme",
    CF_ACCESS_AUD: "aud-tag",
  };

  function withEnv(extra: Record<string, string | undefined>, run: () => void): void {
    const saved = { ...process.env };
    try {
      for (const [key, value] of Object.entries(extra)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      run();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }

  test("nothing set: a LAN instance that asks for a password", () => {
    withEnv({ ...base, LETTA_MODE: undefined }, () => {
      const config = loadConfig();
      expect(config.access).toBe("lan");
      expect(config.signin).toBe("password");
      // No address is involved, so an empty allowlist is correct, not a locked door.
      expect(config.allowedUsers).toEqual([]);
    });
  });

  test("the tunnel token derives both halves, so an existing install needs no new lines", () => {
    withEnv({ ...base, LETTA_MODE: "cloudflared", ...cf, ALLOWED_USERS: "me@example.com" }, () => {
      const config = loadConfig();
      expect(config.access).toBe("cloudflared");
      expect(config.signin).toBe("cf-access");
      expect(config.allowedUsers).toEqual(["me@example.com"]);
    });
  });

  test("ACCESS and the tunnel token must agree, in both directions", () => {
    withEnv({ ...base, LETTA_MODE: undefined, ACCESS: "cloudflared", ...cf }, () => {
      expect(loadConfig).toThrow(/no tunnel exists to serve it/);
    });
    withEnv({ ...base, LETTA_MODE: "cloudflared", ACCESS: "lan" }, () => {
      expect(loadConfig).toThrow(/public hostname points at it/);
    });
  });

  test("an unrecognised value is a typo, and says what was allowed", () => {
    withEnv({ ...base, ACCESS: "tunnel" }, () => {
      expect(loadConfig).toThrow(/ACCESS is "tunnel", which is not one of: lan, cloudflared/);
    });
    withEnv({ ...base, SIGNIN: "ldap" }, () => {
      expect(loadConfig).toThrow(
        /SIGNIN is "ldap", which is not one of: none, password, cf-access, google/,
      );
    });
  });

  test("cf-access needs the tunnel and its connection details", () => {
    withEnv({ ...base, SIGNIN: "cf-access", ALLOWED_USERS: "me@example.com", ...cf }, () => {
      expect(loadConfig).toThrow(/not reached through a Cloudflare Tunnel/);
    });
    withEnv(
      { ...base, LETTA_MODE: "cloudflared", ALLOWED_USERS: "me@example.com", ACCESS: undefined },
      () => {
        expect(loadConfig).toThrow(/Missing required environment variable CF_ACCESS_TEAM_DOMAIN/);
      },
    );
  });

  test("a tunnel with no Access policy is a fine place for a password", () => {
    withEnv({ ...base, LETTA_MODE: "cloudflared", SIGNIN: "password" }, () => {
      const config = loadConfig();
      expect(config.access).toBe("cloudflared");
      expect(config.signin).toBe("password");
      expect(config.allowedUsers).toEqual([]);
    });
  });

  test("SIGNIN=none is refused wherever it would be exposed", () => {
    // A public hostname with nothing in front of it — no opt-in variable, because
    // the combination has no safe reading.
    withEnv({ ...base, LETTA_MODE: "cloudflared", ...cf, SIGNIN: "none" }, () => {
      expect(loadConfig).toThrow(/public hostname with nothing in front of it/);
    });
    withEnv({ ...base, SIGNIN: "none", LETTA_HOST_BIND: "0.0.0.0" }, () => {
      expect(loadConfig).toThrow(/authenticates nobody, but BFF_BIND is 0\.0\.0\.0/);
    });
    withEnv({ ...base, SIGNIN: "none" }, () => {
      // The compose default is loopback, so the machine-local case just works.
      expect(loadConfig().signin).toBe("none");
    });
  });

  test("a tunnel never leaves the direct port open either", () => {
    withEnv(
      {
        ...base,
        LETTA_MODE: "cloudflared",
        ALLOWED_USERS: "me@example.com",
        ...cf,
        LETTA_HOST_BIND: "0.0.0.0",
      },
      () => {
        expect(loadConfig).toThrow(/second way in that nothing guards/);
      },
    );
  });

  test("google sign-in needs the client and the allowlist, both from the environment", () => {
    withEnv({ ...base, SIGNIN: "google", ALLOWED_USERS: "me@example.com" }, () => {
      expect(loadConfig).toThrow(/SIGNIN=google needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
    });
    withEnv(
      { ...base, SIGNIN: "google", GOOGLE_CLIENT_ID: "id.apps", GOOGLE_CLIENT_SECRET: "s3cret" },
      () => {
        expect(loadConfig).toThrow(/Missing required environment variable ALLOWED_USERS/);
      },
    );
    withEnv(
      {
        ...base,
        SIGNIN: "google",
        ALLOWED_USERS: "me@example.com",
        GOOGLE_CLIENT_ID: "id.apps",
        GOOGLE_CLIENT_SECRET: "s3cret",
      },
      () => {
        const config = loadConfig();
        expect(config.google.envClientId).toBe("id.apps");
        expect(config.google.envClientSecret).toBe("s3cret");
      },
    );
  });

  test("the variables the split replaced are an error, not a silent ignore", () => {
    withEnv({ ...base, DEV_BYPASS_EMAIL: "me@example.com" }, () => {
      expect(loadConfig).toThrow(/DEV_BYPASS_EMAIL is gone.*SIGNIN=none/s);
    });
    withEnv({ ...base, DEV_BYPASS_ALLOW_REMOTE: "true" }, () => {
      expect(loadConfig).toThrow(/DEV_BYPASS_ALLOW_REMOTE is gone/);
    });
    withEnv({ ...base, GOOGLE_ALLOW_DEV_BYPASS: "true" }, () => {
      expect(loadConfig).toThrow(/GOOGLE_ALLOW_DEV_BYPASS is gone/);
    });
  });

  test("only a method that authenticates somebody may change Google access", () => {
    withEnv({ ...base, SIGNIN: "none" }, () => {
      expect(googleWritesAllowed(loadConfig())).toBe(false);
    });
    withEnv({ ...base, SIGNIN: "none", GOOGLE_ALLOW_INSECURE_SIGNIN: "true" }, () => {
      expect(googleWritesAllowed(loadConfig())).toBe(true);
    });
    withEnv({ ...base, SIGNIN: "password" }, () => {
      expect(googleWritesAllowed(loadConfig())).toBe(true);
    });
  });

  test("the address-free methods have no allowlist to speak of", () => {
    withEnv({ ...base, SIGNIN: "password", ALLOWED_USERS: "me@example.com" }, () => {
      // Accepted, and reported as unused by the boot log: refusing would break a
      // deployment that switched methods without cleaning its .env.
      expect(loadConfig().allowedUsers).toEqual(["me@example.com"]);
      expect(signinHasAddress("password")).toBe(false);
    });
    expect(signinHasAddress("cf-access")).toBe(true);
    expect(signinHasAddress("google")).toBe(true);
    expect(signinHasAddress("none")).toBe(false);
  });
});

describe("loadConfig app-server token", () => {
  const base = {
    PUBLIC_ORIGIN: "http://localhost:8090",
    LETTA_APP_SERVER_URL: "ws://127.0.0.1:4500",
    SESSION_SECRET: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p67",
  };

  function withEnv(extra: Record<string, string | undefined>, run: () => void): void {
    const saved = { ...process.env };
    try {
      for (const [key, value] of Object.entries(extra)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      run();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }

  test("unset is null, not the empty string", () => {
    // Upstream's client throws on a blank token, so "unset" has to stay unset all
    // the way to its constructor options.
    withEnv({ ...base, LETTA_APP_SERVER_TOKEN: undefined }, () => {
      expect(loadConfig().appServerToken).toBeNull();
    });
  });

  test("a set token is trimmed", () => {
    withEnv({ ...base, LETTA_APP_SERVER_TOKEN: "  tok-1  " }, () => {
      expect(loadConfig().appServerToken).toBe("tok-1");
    });
  });

  test("blank is unset", () => {
    for (const blank of ["", "   ", "\t"]) {
      withEnv({ ...base, LETTA_APP_SERVER_TOKEN: blank }, () => {
        expect(loadConfig().appServerToken).toBeNull();
      });
    }
  });
});

describe("parseAllowedUsers", () => {
  test("splits a comma-separated list", () => {
    expect(parseAllowedUsers("a@example.com,b@example.com", "src")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  test("accepts a single address", () => {
    expect(parseAllowedUsers("solo@example.com", "src")).toEqual(["solo@example.com"]);
  });

  test("normalizes case and surrounding space", () => {
    // isAllowedUser() compares against an already-lowercased address, so a
    // capitalized entry would never match without this.
    expect(parseAllowedUsers("  Mixed@Case.COM , B@Example.com ", "src")).toEqual([
      "mixed@case.com",
      "b@example.com",
    ]);
  });

  test("de-duplicates, including across case differences", () => {
    expect(parseAllowedUsers("a@example.com, A@Example.com", "src")).toEqual(["a@example.com"]);
  });

  test("ignores empty entries rather than yielding blanks", () => {
    expect(parseAllowedUsers("a@example.com,,", "src")).toEqual(["a@example.com"]);
  });

  test("rejects a value with no addresses at all", () => {
    expect(() => parseAllowedUsers(",,,", "ALLOWED_USERS")).toThrow(
      /ALLOWED_USERS lists no addresses/,
    );
  });

  test("rejects an empty string", () => {
    expect(() => parseAllowedUsers("   ", "ALLOWED_USERS")).toThrow(/no addresses/);
  });

  test("rejects an entry that is not an address, naming it", () => {
    // The point of this check is to fail at boot instead of as an unexplained
    // 403 at sign-in — an address matching nothing is otherwise silent.
    expect(() => parseAllowedUsers("a@example.com, oops", "ALLOWED_USERS")).toThrow(
      /not email addresses: oops/,
    );
  });

  test("does not reject unusual but valid addresses", () => {
    // Guards against someone 'improving' the @ check into an email regex.
    const exotic = "a+tag@sub.example.co.uk, first.last@example.museum";
    expect(parseAllowedUsers(exotic, "src")).toEqual([
      "a+tag@sub.example.co.uk",
      "first.last@example.museum",
    ]);
  });

  test("names the source in errors so the operator knows what to fix", () => {
    expect(() => parseAllowedUsers("", "SOME_SOURCE")).toThrow(/SOME_SOURCE/);
  });
});

describe("assertSessionSecretIsStrong", () => {
  const strong = "d6efd2a91c4b7e0f5a3d8c2b1e6f9a4d7c3b8e2f5a1d9c4b7e0f3a6d2c9b5e8f";

  test("accepts a 64-char hex secret", () => {
    expect(() => assertSessionSecretIsStrong(strong)).not.toThrow();
  });

  test("accepts a 32-char secret at exactly the floor", () => {
    expect(() => assertSessionSecretIsStrong("a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6")).not.toThrow();
  });

  test("rejects a secret below the minimum length, naming the length", () => {
    expect(() => assertSessionSecretIsStrong("short")).toThrow(
      /SESSION_SECRET is too short \(5 characters, minimum 32\)/,
    );
  });

  test("rejects one character repeated to reach the minimum", () => {
    expect(() => assertSessionSecretIsStrong("a".repeat(64))).toThrow(
      /one character repeated, which carries no entropy/,
    );
  });

  test("rejects a short pattern tiled to reach the minimum", () => {
    expect(() => assertSessionSecretIsStrong("ab".repeat(32))).toThrow(
      /2-character pattern repeated/,
    );
    expect(() => assertSessionSecretIsStrong("abcd".repeat(16))).toThrow(
      /4-character pattern repeated/,
    );
  });

  test("does not reject a long secret that merely starts with a repeated run", () => {
    // "aa" up front must not trip the tiled-pattern check for the whole value.
    expect(() => assertSessionSecretIsStrong(`aa${strong.slice(2)}`)).not.toThrow();
  });

  test("every rejection names the command that fixes it", () => {
    for (const weak of ["short", "a".repeat(64), "ab".repeat(32)]) {
      expect(() => assertSessionSecretIsStrong(weak)).toThrow(/openssl rand -hex 32/);
    }
  });
});

describe("loadConfig session secret", () => {
  const base = {
    PUBLIC_ORIGIN: "http://localhost:8090",
    LETTA_APP_SERVER_URL: "ws://127.0.0.1:4500",
  };

  function withEnv(extra: Record<string, string | undefined>, run: () => void): void {
    const saved = { ...process.env };
    try {
      for (const [key, value] of Object.entries(extra)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      run();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }

  test("boots with a strong secret", () => {
    withEnv({ ...base, SESSION_SECRET: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p67" }, () => {
      expect(loadConfig().sessionSecret).toHaveLength(33);
    });
  });

  test("refuses to boot with a weak secret", () => {
    withEnv({ ...base, SESSION_SECRET: "hunter2" }, () => {
      expect(loadConfig).toThrow(/SESSION_SECRET is too short/);
    });
  });

  test("still reports a missing secret as missing, not as too short", () => {
    withEnv({ ...base, SESSION_SECRET: undefined }, () => {
      expect(loadConfig).toThrow(/Missing required environment variable SESSION_SECRET/);
    });
  });
});

describe("enabledFeatureNames", () => {
  test("names every feature that is on, `pi` included", () => {
    expect(
      enabledFeatureNames({
        web: true,
        google: true,
        codex: false,
        claude: false,
        pi: true,
        telegram: false,
      }),
    ).toEqual(["web", "google", "pi"]);
  });

  test("no feature token means no names at all", () => {
    expect(
      enabledFeatureNames({
        web: false,
        google: false,
        codex: false,
        claude: false,
        pi: false,
        telegram: false,
      }),
    ).toEqual([]);
  });

  test("every FeatureFlags key is nameable, so the boot log cannot drop one", () => {
    const all = { web: true, google: true, codex: true, claude: true, pi: true, telegram: true };
    expect(enabledFeatureNames(all).sort()).toEqual(Object.keys(all).sort());
  });
});

describe("loadConfig context watchdog", () => {
  function withEnv(extra: Record<string, string | undefined>, run: () => void): void {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        PUBLIC_ORIGIN: "http://localhost:8090",
        LETTA_APP_SERVER_URL: "ws://127.0.0.1:4500",
        SESSION_SECRET: "config-tests-session-secret-0123456789",
      });
      for (const [key, value] of Object.entries(extra)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      run();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }

  test("an unset or empty ratio takes the default, since Compose passes empty", () => {
    withEnv({ CONTEXT_WATCHDOG_RATIO: undefined }, () => {
      expect(loadConfig().contextWatchdogRatio).toBe(0.9);
    });
    withEnv({ CONTEXT_WATCHDOG_RATIO: "" }, () => {
      expect(loadConfig().contextWatchdogRatio).toBe(0.9);
    });
  });

  test("0 means off, not a BFF that refuses to boot", () => {
    withEnv({ CONTEXT_WATCHDOG_RATIO: "0" }, () => {
      expect(loadConfig().contextWatchdogRatio).toBe(0);
    });
  });

  test("a share outside 0-1 is a config error", () => {
    withEnv({ CONTEXT_WATCHDOG_RATIO: "1.5" }, () => {
      expect(() => loadConfig()).toThrow(/CONTEXT_WATCHDOG_RATIO/);
    });
  });
});
