import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import {
  fetchSkills,
  groupSkills,
  type SkillList,
  type SkillSource,
  type SkillSummary,
  skillDir,
  summarizeSkills,
} from "../lib/skills.ts";
import type { SessionApi } from "../state/use-session.ts";
import { Icon } from "./Icon.tsx";

/**
 * The skills one agent can load, from the BFF rather than device status:
 * upstream only reports skills on a live conversation runtime, which is evicted
 * between turns (see bff/src/skills/). `version` moves on every skills_updated
 * frame — an agent's own shell can enable or disable a skill too.
 */
function useSkillList(
  session: SessionApi,
  agentId: string | null,
  cwd: string | null,
  version: number,
) {
  const [list, setList] = useState<SkillList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      setList(await fetchSkills(agentId, cwd));
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [agentId, cwd]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the refresh trigger
  useEffect(() => {
    if (session.ready) void load();
  }, [session.ready, load, version]);

  return { list, loading, error, load };
}

interface AgentSkillsProps {
  session: SessionApi;
  agentId: string | null;
  cwd: string | null;
  version: number;
  /** Adding or removing a skill for every agent lives in global Settings. */
  onOpenGlobal: () => void;
}

/** Agent → Skills: every skill this agent sees, from every scope. Read-only. */
export function AgentSkills({ session, agentId, cwd, version, onOpenGlobal }: AgentSkillsProps) {
  const { list, loading, error, load } = useSkillList(session, agentId, cwd, version);
  /** Bundled is long and rarely what you came for, so it starts closed. */
  const [collapsed, setCollapsed] = useState<Set<SkillSource>>(() => new Set(["bundled"]));

  const toggleGroup = (source: SkillSource) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });

  const skills = list?.skills ?? [];

  return (
    <>
      <div className="pane-bar">
        <span className="spacer" />
        <span className="muted small">
          {agentId ? (list ? summarizeSkills(skills) : "Loading skills…") : "Pick an agent first"}
        </span>
        <button
          type="button"
          className="link"
          disabled={loading || !agentId}
          onClick={() => void load()}
          title="Reload skills"
          aria-label="Reload skills"
        >
          <Icon name="refresh" />
        </button>
      </div>
      {error ? (
        <p className="warning small" role="alert">
          <span>{error}</span>
        </p>
      ) : null}

      {groupSkills(skills).map((group) => {
        const open = !collapsed.has(group.source);
        return (
          <section key={group.source} className="skill-group">
            <button
              type="button"
              className="tool-head skill-group-head"
              aria-expanded={open}
              onClick={() => toggleGroup(group.source)}
            >
              <span className="tag">
                {group.label} ({group.skills.length})
              </span>
              <span className="muted small skill-group-hint">{group.hint}</span>
              <Icon name={open ? "chevron-down" : "chevron-right"} />
            </button>
            {open ? (
              <ul className="list compact skill-list">
                {group.skills.map((skill) => (
                  <SkillRow key={skill.id} skill={skill} />
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}

      <SkillErrors list={list} />

      <p className="section-note">Installing for this agent</p>
      <p className="muted small pad">
        The browser has no shell, so ask the agent in Chat to clone it into its working directory:
      </p>
      <pre className="tool-args pad-x">
        Clone https://github.com/me/my-skill into .agents/skills/my-skill in your working directory.
      </pre>
      <p className="muted small pad">
        Global skills are shared by every agent, and are enabled and disabled in{" "}
        <button type="button" className="link inline" onClick={onOpenGlobal}>
          Settings → Global skills
        </button>
        .
      </p>
    </>
  );
}

interface GlobalSkillsProps {
  session: SessionApi;
  /**
   * `/api/skills` resolves one agent's view; the global scope is the same for
   * every agent, so any agent will do. A global skill a project or agent skill
   * of the same name overrides is not listed.
   */
  agentId: string | null;
  cwd: string | null;
  version: number;
}

/** Settings → Global skills: the `/root/.letta/skills` links, for every agent. */
export function GlobalSkills({ session, agentId, cwd, version }: GlobalSkillsProps) {
  const { list, loading, error, load } = useSkillList(session, agentId, cwd, version);
  const [status, setStatus] = useState("");
  const [path, setPath] = useState("");

  /**
   * `skill_enable` does exactly one thing: symlink the directory it is given
   * into `/root/.letta/skills`, which is the GLOBAL scope — every agent, every
   * conversation. There is no protocol command for any narrower scope, so the
   * label says global rather than pretending otherwise.
   */
  const enable = async () => {
    const skillPath = path.trim();
    if (!skillPath) return;
    setStatus(`Enabling ${skillPath}…`);
    try {
      const response = await session.request<{ success?: boolean; error?: string }>(
        "skill_enable",
        { skill_path: skillPath },
      );
      if (response?.success === false) {
        setStatus(response.error ?? "Failed");
        return;
      }
      setStatus("Enabled for every agent.");
      setPath("");
      void load();
    } catch (cause) {
      setStatus(errorMessage(cause));
    }
  };

  // `skill_disable` takes the symlink's name in /root/.letta/skills and refuses
  // anything that is not a symlink — so only linked global skills offer it.
  const disable = async (skill: SkillSummary) => {
    if (!skill.link) return;
    setStatus(`Disabling ${skill.name}…`);
    try {
      const response = await session.request<{ success?: boolean; error?: string }>(
        "skill_disable",
        { name: skill.link },
      );
      if (response?.success === false) {
        setStatus(response.error ?? "Failed");
        return;
      }
      setStatus("");
      void load();
    } catch (cause) {
      setStatus(errorMessage(cause));
    }
  };

  const global = (list?.skills ?? []).filter((skill) => skill.source === "global");

  return (
    <>
      <div className="pane-bar">
        <span className="spacer" />
        <span className="muted small">
          {agentId
            ? list
              ? `${global.length} global skill${global.length === 1 ? "" : "s"}`
              : "Loading skills…"
            : "Create an agent to list skills"}
        </span>
        <button
          type="button"
          className="link"
          disabled={loading || !agentId}
          onClick={() => void load()}
          title="Reload skills"
          aria-label="Reload skills"
        >
          <Icon name="refresh" />
        </button>
      </div>
      {status || error ? <p className="muted small pad">{status || error}</p> : null}

      {global.length > 0 ? (
        <ul className="list compact skill-list">
          {global.map((skill) => (
            <SkillRow key={skill.id} skill={skill} onDisable={() => void disable(skill)} />
          ))}
        </ul>
      ) : null}

      <SkillErrors list={list} />

      <p className="section-note">Enable a skill for every agent</p>
      <p className="muted small pad">
        Links a directory under <code>/work</code> that contains a <code>SKILL.md</code> into{" "}
        <code>/root/.letta/skills</code>. The files stay where they are, so edits to them take
        effect on the agent's next turn. Disable removes only the link.
      </p>
      <div className="pad-x">
        <label className="field">
          Skill directory
          <input
            value={path}
            placeholder="/work/shared-skills/my-skill"
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="button"
          disabled={!path.trim()}
          onClick={() => void enable()}
        >
          Enable globally
        </button>
      </div>

      <p className="section-note">Installing from git</p>
      <p className="muted small pad">
        The browser has no shell, so ask an agent in Chat to clone it outside any one agent's
        directory, then enable that path above:
      </p>
      <pre className="tool-args pad-x">
        Clone https://github.com/me/my-skill into /work/shared-skills/my-skill.
      </pre>
    </>
  );
}

function SkillErrors({ list }: { list: SkillList | null }) {
  if (!list || list.errors.length === 0) return null;
  return (
    <p className="warning small">
      {list.errors.length} skill file{list.errors.length === 1 ? "" : "s"} could not be read:{" "}
      {list.errors.map((error) => `${error.path} (${error.message})`).join("; ")}
    </p>
  );
}

/**
 * One skill: name and a one-line description, tap for the rest. Only rows whose
 * description is actually cut off get the chevron — a short one has nothing
 * more to show.
 */
function SkillRow({ skill, onDisable }: { skill: SkillSummary; onDisable?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const descRef = useRef<HTMLSpanElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes
  useLayoutEffect(() => {
    const el = descRef.current;
    if (el && !expanded) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [skill.description, expanded]);

  const expandable = clamped || expanded;
  const badges = [
    ...(skill.overrides?.length ? [`overrides ${skill.overrides.join(", ")}`] : []),
    ...(skill.managedBy ? [`managed by ${skill.managedBy}`] : []),
  ];

  return (
    <li className="skill-item">
      <div className="skill-row">
        <button
          type="button"
          className="skill-main"
          aria-expanded={expandable ? expanded : undefined}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="skill-title">
            <strong>{skill.name}</strong>
            {badges.map((badge) => (
              <span key={badge} className="tag muted">
                {badge}
              </span>
            ))}
            {expandable ? (
              <Icon name={expanded ? "chevron-down" : "chevron-right"} className="chevron" />
            ) : null}
          </span>
          <span ref={descRef} className={`skill-desc muted${expanded ? " expanded" : ""}`}>
            {skill.description}
          </span>
          {expanded ? <code className="skill-path muted">{skillDir(skill.path)}</code> : null}
        </button>
        {onDisable && skill.link && !skill.managedBy ? (
          <button type="button" className="link danger" onClick={onDisable}>
            Disable
          </button>
        ) : null}
      </div>
    </li>
  );
}
