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
        <p className="section-note">
          Nothing reaches this instance except through the tunnel, and the port is closed to the
          network — a direct address will not answer, which is the point. Who gets in is{" "}
          <strong>{SIGNIN_LABELS[signin]}</strong>.
        </p>
      ) : openToNetwork === false ? (
        <p className="section-note">
          The port listens on this machine only, so nothing outside it can knock. Sign-in is{" "}
          <strong>{SIGNIN_LABELS[signin]}</strong>.
        </p>
      ) : openToNetwork === true ? (
        <>
          <p className="warning section-note">
            The port listens on <code>{hostBind}</code>, so anyone on this network can reach it.
            Sign-in is <strong>{SIGNIN_LABELS[signin]}</strong> — that is the only thing between
            them and this agent.
          </p>
          <p className="muted small">
            To close it, set <code>BFF_BIND=127.0.0.1</code> in <code>docker/.env</code> and
            redeploy, or put a tunnel in front with <code>ACCESS=cloudflared</code>.
          </p>
        </>
      ) : (
        <p className="section-note">
          Sign-in is <strong>{SIGNIN_LABELS[signin]}</strong>.
        </p>
      )}

      <p className="muted small">
        These are deployment settings, so they are read from <code>docker/.env</code> and are not
        editable here: <code>ACCESS</code> picks the route, <code>BFF_BIND</code> the interface, and
        a mismatch between <code>ACCESS</code> and the <code>cloudflared</code> profile token stops
        the BFF at boot rather than leaving it reachable by a route nobody meant to open.
      </p>
    </>
  );
}
