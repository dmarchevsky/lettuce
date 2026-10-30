"""Refuse any Google request that would deliver mail to an address off the allowed list.

Settings -> Google Workspace can hold an "Allowed recipients" list. Agent shells
reach this sidecar directly, so a check in the BFF is advisory; this one sits
in the workspace-mcp process itself, on `AuthorizedHttp.request` — the one call
every credentialed Google request goes through, batches included. It reads the
request Google would act on, so recipients workspace-mcp derives on its own
(reply-all, forwards) are checked like any other.

What delivers mail, and so what is checked:
  * Gmail `messages.send`: every To/Cc/Bcc address of the raw message;
  * Gmail filters: a `forward` action;
  * Calendar events: attendees (an invitation is an email), and whoever an
    update, delete or RSVP notifies.

Fail closed: a mutating Gmail or Calendar request this module does not know is
refused, so a workspace-mcp upgrade that starts calling a new endpoint is
blocked until someone looks at it, rather than let through.

An empty list installs nothing: no list means no restriction.
"""

import base64
import email
import email.policy
import json
import re
from urllib.parse import parse_qs, unquote, urlsplit

READS = {"GET", "HEAD"}

# Gmail writes that deliver nothing, by path after /gmail/v1/users/<id>/.
GMAIL_QUIET = [
    ("POST", ["drafts"]),
    ("PUT", ["drafts", "*"]),
    ("DELETE", ["drafts", "*"]),
    ("POST", ["labels"]),
    ("PUT", ["labels", "*"]),
    ("PATCH", ["labels", "*"]),
    ("DELETE", ["labels", "*"]),
    ("POST", ["messages", "batchModify"]),
    ("POST", ["messages", "*", "modify"]),
    ("POST", ["messages", "*", "trash"]),
    ("POST", ["messages", "*", "untrash"]),
    ("POST", ["threads", "*", "modify"]),
    ("POST", ["threads", "*", "trash"]),
    ("POST", ["threads", "*", "untrash"]),
    ("DELETE", ["settings", "filters", "*"]),
]

# Calendar writes that notify nobody, by path after /calendar/v3/.
CALENDAR_QUIET = [
    ("POST", ["calendars"]),
    ("PUT", ["calendars", "*"]),
    ("PATCH", ["calendars", "*"]),
    ("DELETE", ["calendars", "*"]),
    ("POST", ["users", "me", "calendarList"]),
    ("PUT", ["users", "me", "calendarList", "*"]),
    ("PATCH", ["users", "me", "calendarList", "*"]),
    ("DELETE", ["users", "me", "calendarList", "*"]),
]

AUTO_DECLINE_PROPERTIES = ("outOfOfficeProperties", "focusTimeProperties")

SETTINGS_HINT = "Settings -> Google Workspace -> Allowed recipients"


class Allowed:
    """The allowed list plus the connected account, which may always mail itself."""

    def __init__(self, entries, own=None):
        self.addresses = set()
        self.domains = set()
        for entry in [*entries, *([own] if own else [])]:
            entry = entry.strip().lower()
            if entry.startswith("@"):
                self.domains.add(entry[1:])
            elif entry:
                self.addresses.add(entry)

    def __contains__(self, address):
        address = address.strip().lower()
        if address in self.addresses:
            return True
        local, at, domain = address.rpartition("@")
        return bool(local and at and domain in self.domains)

    def outside(self, addresses):
        """The addresses not allowed, in order and without repeats."""
        seen = []
        for address in addresses:
            address = address.strip().lower()
            if address not in self and address not in seen:
                seen.append(address)
        return seen


def refused(what, addresses):
    return f"Refused: {what} {', '.join(addresses)}, not on the allowed recipients list ({SETTINGS_HINT})."


def _segments(path, prefix):
    rest = path[len(prefix):].strip("/")
    return [unquote(part) for part in rest.split("/")] if rest else []


def _matches(method, segments, table):
    for want_method, pattern in table:
        if method != want_method or len(pattern) != len(segments):
            continue
        if all(p == "*" or p == s for p, s in zip(pattern, segments)):
            return True
    return False


def _json(body):
    if body is None:
        return {}
    if isinstance(body, (bytes, bytearray)):
        body = body.decode("utf-8")
    if not isinstance(body, str):
        raise ValueError("unreadable request body")
    value = json.loads(body) if body.strip() else {}
    if not isinstance(value, dict):
        raise ValueError("request body is not an object")
    return value


# ---- Gmail ------------------------------------------------------------------

ADDRESS_HEADERS = ("to", "cc", "bcc")
QUOTED = re.compile(r'"(?:[^"\\]|\\.)*"')


def message_recipients(raw):
    """Every recipient address of an RFC 822 message, or a reason it cannot be trusted.

    Strict on purpose: anything Python's parser and Gmail's might read
    differently is refused rather than guessed at.
    """
    message = email.message_from_bytes(raw, policy=email.policy.default)
    if message.defects:
        return None, "the message could not be read cleanly"
    for name in message.keys():
        if name.lower().startswith("resent-"):
            return None, f"the message carries a {name} header"
    addresses = []
    for name in ADDRESS_HEADERS:
        for header in message.get_all(name, []):
            if getattr(header, "defects", None):
                return None, f"its {name.capitalize()} header could not be read cleanly"
            groups = getattr(header, "groups", ())
            if any(group.display_name is not None for group in groups):
                return None, f"its {name.capitalize()} header uses group syntax"
            found = [address.addr_spec for address in header.addresses]
            # One "@" per address outside quoted display names (a label, never
            # delivered to): any other "@" is an address the parser did not see.
            if QUOTED.sub("", str(header)).count("@") != len(found):
                return None, f"its {name.capitalize()} header is ambiguous"
            for spec in found:
                local, _, domain = spec.partition("@")
                if spec.count("@") != 1 or '"' in spec or not local or not domain:
                    return None, f"it has an unusable address {spec!r}"
                addresses.append(spec)
    if not addresses:
        return None, "the message has no recipients"
    return addresses, None


def _decode_raw(value):
    if not isinstance(value, str) or not value:
        raise ValueError("no raw message")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def decide_gmail(method, segments, body, allowed):
    # users/<id>/...
    if len(segments) < 2 or segments[0] != "users":
        return "Refused: an unrecognised Gmail request while an allowed recipients list is set."
    rest = segments[2:]
    if method == "POST" and rest == ["messages", "send"]:
        try:
            raw = _decode_raw(_json(body).get("raw"))
        except (ValueError, TypeError) as error:
            return f"Refused: the message to send could not be checked ({error})."
        addresses, problem = message_recipients(raw)
        if problem:
            return f"Refused: {problem}, so its recipients cannot be checked against the allowed list."
        outside = allowed.outside(addresses)
        return refused("sending to", outside) if outside else None
    if method == "POST" and rest == ["drafts", "send"]:
        return (
            "Refused: sending a draft is not supported while an allowed recipients list is set. "
            "Send the message directly."
        )
    if method == "POST" and rest == ["settings", "filters"]:
        try:
            forward = (_json(body).get("action") or {}).get("forward")
        except (ValueError, AttributeError) as error:
            return f"Refused: the filter could not be checked ({error})."
        if forward:
            outside = allowed.outside([forward])
            return refused("a filter forwarding to", outside) if outside else None
        return None
    if _matches(method, rest, GMAIL_QUIET):
        return None
    return "Refused: this Gmail change is not allowed while an allowed recipients list is set."


# ---- Calendar ---------------------------------------------------------------


def _attendee_emails(event):
    emails = []
    for attendee in event.get("attendees") or []:
        if isinstance(attendee, dict) and attendee.get("email"):
            emails.append(attendee["email"])
    return emails


def _self_emails(event):
    """Addresses the event itself marks as the connected account."""
    own = {
        attendee["email"].lower()
        for attendee in event.get("attendees") or []
        if isinstance(attendee, dict) and attendee.get("self") and attendee.get("email")
    }
    organizer = event.get("organizer") or {}
    if organizer.get("self") and organizer.get("email"):
        own.add(organizer["email"].lower())
    return own


def _notifies(query):
    # Absent means whatever Google defaults to; treat it as notifying.
    return (query.get("sendUpdates") or [""])[0] != "none"


def _auto_declines(event):
    for key in AUTO_DECLINE_PROPERTIES:
        properties = event.get(key)
        if not isinstance(properties, dict):
            continue
        if properties.get("autoDeclineMode", "declineNone") != "declineNone":
            return True
    return False


AUTO_DECLINE_REFUSAL = (
    "Refused: automatic declines mail each organizer whose meeting conflicts, so they are off while "
    "an allowed recipients list is set. Use auto_decline_mode \"declineNone\"."
)
NOTIFY_REFUSAL = (
    "Refused: this change would notify {who}, not on the allowed recipients list ({hint}). "
    "Retry with send_updates \"none\" (notify_attendees false) to change it without telling them."
)


def decide_calendar(method, segments, query, body, allowed, fetch_event):
    if _matches(method, segments, CALENDAR_QUIET):
        return None
    is_events = len(segments) >= 3 and segments[0] == "calendars" and segments[2] == "events"
    if not is_events:
        return "Refused: this Calendar change is not allowed while an allowed recipients list is set."
    tail = segments[3:]
    try:
        payload = _json(body)
    except ValueError as error:
        return f"Refused: the event could not be checked ({error})."

    if method == "POST" and tail in ([], ["import"]):
        if _auto_declines(payload):
            return AUTO_DECLINE_REFUSAL
        outside = allowed.outside(_attendee_emails(payload))
        return refused("inviting", outside) if outside else None

    if len(tail) == 1 and method in ("PATCH", "PUT", "DELETE"):
        existing = fetch_event()
        if existing is None:
            return "Refused: the event could not be read to check who it would notify."
        own = _self_emails(existing)
        before = _attendee_emails(existing)
        if method != "DELETE":
            # A moved auto-declining event declines whatever it now overlaps,
            # unless this change also turns the declining off.
            keeps_declining = _auto_declines(existing) and not any(
                key in payload for key in AUTO_DECLINE_PROPERTIES
            )
            if _auto_declines(payload) or keeps_declining:
                return AUTO_DECLINE_REFUSAL
            after = _attendee_emails(payload) if "attendees" in payload else before
            existing_set = {address.lower() for address in before}
            added = [address for address in after if address.lower() not in existing_set]
            outside = allowed.outside(added)
            if outside:
                return refused("inviting", outside)
            organizer = (existing.get("organizer") or {}).get("email")
            if organizer and organizer.lower() not in own and _comment_changed(existing, payload):
                outside = allowed.outside([organizer])
                if outside:
                    return refused("an RSVP note to", outside)
        else:
            after = []
        if _notifies(query):
            organizer = (existing.get("organizer") or {}).get("email")
            everyone = [*before, *after, *([organizer] if organizer else [])]
            notified = [address for address in everyone if address.lower() not in own]
            outside = allowed.outside(notified)
            if outside:
                return NOTIFY_REFUSAL.format(who=", ".join(outside), hint=SETTINGS_HINT)
        return None

    return "Refused: this Calendar change is not allowed while an allowed recipients list is set."


def _comment_changed(existing, payload):
    """Whether the account's own RSVP note changes: the organizer sees it, mail or not."""
    if "attendees" not in payload:
        return False
    before = {
        attendee.get("email", "").lower(): attendee.get("comment")
        for attendee in existing.get("attendees") or []
        if isinstance(attendee, dict) and attendee.get("self")
    }
    for attendee in payload.get("attendees") or []:
        if not isinstance(attendee, dict):
            continue
        address = attendee.get("email", "").lower()
        if address in before and attendee.get("comment") != before[address]:
            return True
    return False


# ---- Entry points -----------------------------------------------------------

BATCH_PART_LINE = re.compile(rb"^(GET|HEAD|POST|PUT|PATCH|DELETE)\s+\S+\s+HTTP/1\.1\s*$", re.MULTILINE)


def decide(method, uri, body, allowed, fetch_event):
    """None to let the request through, or the reason it is refused."""
    method = (method or "GET").upper()
    parts = urlsplit(uri)
    path = parts.path
    if path.startswith("/batch"):
        data = body.encode("utf-8") if isinstance(body, str) else (body or b"")
        verbs = [match.group(1).decode() for match in BATCH_PART_LINE.finditer(data)]
        if not verbs or any(verb not in READS for verb in verbs):
            return "Refused: batched changes are not allowed while an allowed recipients list is set."
        return None
    if method in READS:
        return None
    if path.startswith("/upload/gmail/v1/"):
        return "Refused: uploaded Gmail messages are not allowed while an allowed recipients list is set."
    if path.startswith("/gmail/v1/"):
        return decide_gmail(method, _segments(path, "/gmail/v1/"), body, allowed)
    if path.startswith("/calendar/v3/"):
        query = parse_qs(parts.query)
        return decide_calendar(method, _segments(path, "/calendar/v3/"), query, body, allowed, fetch_event)
    return None


def install(entries, own=None):
    """Guard every credentialed Google request in this process. No entries: nothing installed."""
    if not entries:
        return False
    import google_auth_httplib2
    from core.utils import UserInputError

    allowed = Allowed(entries, own)
    original = google_auth_httplib2.AuthorizedHttp.request

    def guarded(self, uri, method="GET", body=None, headers=None, *args, **kwargs):
        def fetch_event():
            event_uri = urlsplit(uri)._replace(query="", fragment="").geturl()
            try:
                response, content = original(self, event_uri, "GET")
            except Exception:
                return None
            if response.status != 200:
                return None
            try:
                return _json(content)
            except ValueError:
                return None

        reason = decide(method, uri, body, allowed, fetch_event)
        if reason:
            raise UserInputError(reason)
        return original(self, uri, method, body, headers, *args, **kwargs)

    google_auth_httplib2.AuthorizedHttp.request = guarded
    return True
