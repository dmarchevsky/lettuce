import type { ReactNode } from "react";
import type { Component } from "../lib/protocol.ts";
import { SIGNIN_LABELS, type Signin } from "../lib/signin.ts";

interface Props {
  access: "lan" | "cloudflared";
  signin: Signin;
  hostBind?: string;
  publicOrigin?: string;
  components?: Component[];
}

/**
 * Settings → Access: how this instance is reached, and what that implies for
 * who may knock. Read-only by design — the route is chosen by `ACCESS` and the
 * `cloudflared` profile token in `docker/.env`, because changing it means
 * restarting containers and (for a tunnel) editing DNS. The section's job is to
 * answer "could someone else reach this?" without making anyone read compose.
 *
 * The pair of settings that belongs together lives next door, in Sign-in:
 * `ACCESS` is where it is reachable, `SIGNIN` is who gets in, and only the
 * combination of the two says whether the instance is exposed.
 */
/** "127.0.0.1" and "0.0.0.0" are not the same sentence, and only one of them is safe. */
function bindLabel(hostBind: string): string {
  return hostBind === "127.0.0.1" || hostBind === "localhost"
    ? `${hostBind} — this machine only`
    : `${hostBind} — every interface`;
}

export function AccessSection({ access, signin, hostBind, publicOrigin, components }: Props) {
  const openToNetwork = hostBind ? hostBind !== "127.0.0.1" && hostBind !== "localhost" : null;
  const tunnel = components?.find((component) => component.name === "Cloudflare Tunnel");

  const rows: [string, ReactNode][] = [
    [
      "Reached through",
      access === "cloudflared" ? "Cloudflare Tunnel" : "Direct (LAN / localhost)",
    ],
    ...(publicOrigin ? ([["Public origin", publicOrigin]] as [string, ReactNode][]) : []),
    ...(hostBind ? ([["Port listens on", bindLabel(hostBind)]] as [string, ReactNode][]) : []),
    ...(tunnel ? ([["Cloudflare Tunnel", tunnel.version]] as [string, ReactNode][]) : []),
  ];

  return (
    <>
      <ul className="list">
        {rows.map(([label, value]) => (
          <li key={label} className="row-between pad">
            <span className="muted">{label}</span>
            <span>{value}</span>
          </li>
        ))}
      </ul>

      {access === "cloudflared" ? (
        <p className="section-copy">
          Only the tunnel reaches this instance — a direct address will not answer. Who gets in is{" "}
          <strong>{SIGNIN_LABELS[signin]}</strong>.
        </p>
      ) : openToNetwork === true ? (
        <p className="warning">
          The port listens on <code>{hostBind}</code>, so anyone on this network can reach it, and
          sign-in is <strong>{SIGNIN_LABELS[signin]}</strong> — the only thing between them and this
          agent. To close it, set <code>BFF_BIND=127.0.0.1</code> or put the tunnel in front with{" "}
          <code>ACCESS=cloudflared</code>.
        </p>
      ) : (
        <p className="section-copy">
          {openToNetwork === false ? "The port listens on this machine only. " : ""}Sign-in is{" "}
          <strong>{SIGNIN_LABELS[signin]}</strong>.
        </p>
      )}

      <p className="section-copy">
        Read from <code>docker/.env</code>: <code>ACCESS</code> picks the route and{" "}
        <code>BFF_BIND</code> the interface, so a change needs a redeploy, not a click here.
      </p>
    </>
  );
}
