"""The recipient guard, against the libraries the image really installs.

Run at image build (Dockerfile), so a workspace-mcp or googleapiclient bump that
moves the hook point fails the build instead of leaving the guard a no-op.
"""

import base64
import json
import os
import tempfile
import unittest
from unittest import mock

import google_auth_httplib2
import launch
import recipient_guard
import supervisor
from core.utils import UserInputError
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import HttpMockSequence
from recipient_guard import Allowed, decide

GMAIL_SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send?alt=json"
EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
EVENT = f"{EVENTS}/ev1"
ALLOWED = Allowed(["friend@example.com", "@example.org"], own="me@example.net")


def raw_body(message):
    data = message.encode() if isinstance(message, str) else message
    return json.dumps({"raw": base64.urlsafe_b64encode(data).decode().rstrip("=")})


def mail(headers):
    return "\r\n".join([*headers, "Subject: hi", "", "body", ""])


def no_fetch():
    raise AssertionError("no event fetch expected")


def send(headers):
    return decide("POST", GMAIL_SEND, raw_body(mail(headers)), ALLOWED, no_fetch)


class AllowedTest(unittest.TestCase):
    def test_exact_domain_and_own(self):
        self.assertIn("Friend@Example.com", ALLOWED)
        self.assertIn("anyone@example.org", ALLOWED)
        self.assertIn("me@example.net", ALLOWED)
        self.assertNotIn("friend+x@example.com", ALLOWED)
        self.assertNotIn("x@sub.example.org", ALLOWED)
        self.assertNotIn("@example.org", ALLOWED)


class GmailSendTest(unittest.TestCase):
    def test_allowed_recipients_pass(self):
        self.assertIsNone(send(["To: Friend <friend@example.com>", "Cc: a@example.org, me@example.net"]))

    def test_unlisted_to_cc_or_bcc_refused(self):
        for header in ("To", "Cc", "Bcc"):
            reason = send(["To: friend@example.com", f"{header}: stranger@example.com"])
            self.assertIn("stranger@example.com", reason)

    def test_second_to_header_is_read(self):
        self.assertIn("x@evil.test", send(["To: friend@example.com", "To: x@evil.test"]))

    def test_quoted_display_name_is_only_a_label(self):
        # How many clients write a sender with no name; reply-all copies it.
        self.assertIsNone(send(['To: "friend@example.com" <friend@example.com>']))
        self.assertIsNone(send(['To: "x@evil.test" <friend@example.com>']))
        self.assertIn("x@evil.test", send(['To: "friend@example.com" <x@evil.test>']))

    def test_missing_comma_refused(self):
        self.assertIsNotNone(send(["To: friend@example.com x@evil.test"]))

    def test_group_syntax_refused(self):
        self.assertIsNotNone(send(["To: team: friend@example.com, x@evil.test;"]))

    def test_resent_headers_refused(self):
        self.assertIsNotNone(send(["To: friend@example.com", "Resent-To: x@evil.test"]))

    def test_no_recipients_refused(self):
        self.assertIsNotNone(send(["From: me@example.net"]))

    def test_unreadable_body_refused(self):
        self.assertIsNotNone(decide("POST", GMAIL_SEND, "not json", ALLOWED, no_fetch))
        self.assertIsNotNone(decide("POST", GMAIL_SEND, json.dumps({}), ALLOWED, no_fetch))

    def test_encoded_display_name_still_checks_address(self):
        self.assertIsNone(send(["To: =?utf-8?b?w4lsaWU=?= <friend@example.com>"]))
        self.assertIsNotNone(send(["To: =?utf-8?b?w4lsaWU=?= <x@evil.test>"]))


class GmailOtherTest(unittest.TestCase):
    base = "https://gmail.googleapis.com/gmail/v1/users/me"

    def test_drafts_send_refused(self):
        self.assertIsNotNone(decide("POST", f"{self.base}/drafts/send", "{}", ALLOWED, no_fetch))

    def test_quiet_writes_pass(self):
        for method, path in [
            ("POST", "drafts"),
            ("PUT", "drafts/d1"),
            ("POST", "labels"),
            ("DELETE", "labels/l1"),
            ("POST", "messages/m1/modify"),
            ("POST", "messages/batchModify"),
            ("DELETE", "settings/filters/f1"),
        ]:
            self.assertIsNone(decide(method, f"{self.base}/{path}", "{}", ALLOWED, no_fetch), path)

    def test_filter_forward_checked(self):
        url = f"{self.base}/settings/filters"
        forward = lambda to: json.dumps({"criteria": {}, "action": {"forward": to}})
        self.assertIsNone(decide("POST", url, forward("friend@example.com"), ALLOWED, no_fetch))
        self.assertIsNotNone(decide("POST", url, forward("x@evil.test"), ALLOWED, no_fetch))
        self.assertIsNone(decide("POST", url, json.dumps({"action": {"addLabelIds": ["X"]}}), ALLOWED, no_fetch))

    def test_unknown_writes_refused(self):
        for method, path in [
            ("PUT", "settings/vacation"),
            ("POST", "settings/forwardingAddresses"),
            ("PUT", "settings/autoForwarding"),
            ("POST", "settings/sendAs"),
            ("POST", "messages/import"),
            ("POST", "watch"),
        ]:
            self.assertIsNotNone(decide(method, f"{self.base}/{path}", "{}", ALLOWED, no_fetch), path)

    def test_uploads_refused(self):
        url = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media"
        self.assertIsNotNone(decide("POST", url, b"To: friend@example.com\r\n\r\nx", ALLOWED, no_fetch))

    def test_reads_pass(self):
        self.assertIsNone(decide("GET", f"{self.base}/messages/m1", None, ALLOWED, no_fetch))

    def test_batch_of_reads_only(self):
        url = "https://gmail.googleapis.com/batch/gmail/v1"
        reads = "--b\r\n\r\nGET /gmail/v1/users/me/messages/1 HTTP/1.1\r\n\r\n--b--"
        writes = reads + "\r\nPOST /gmail/v1/users/me/messages/1/modify HTTP/1.1\r\n\r\n{}"
        self.assertIsNone(decide("POST", url, reads, ALLOWED, no_fetch))
        self.assertIsNotNone(decide("POST", url, writes, ALLOWED, no_fetch))


def event(attendees=(), organizer="me@example.net", **extra):
    people = [{"email": a, **({"self": True} if a == "me@example.net" else {})} for a in attendees]
    return {"attendees": people, "organizer": {"email": organizer, "self": organizer == "me@example.net"}, **extra}


class CalendarTest(unittest.TestCase):
    def test_insert_attendees_checked(self):
        ok = json.dumps(event(["friend@example.com"]))
        bad = json.dumps(event(["friend@example.com", "x@evil.test"]))
        self.assertIsNone(decide("POST", f"{EVENTS}?sendUpdates=all", ok, ALLOWED, no_fetch))
        self.assertIn("x@evil.test", decide("POST", f"{EVENTS}?sendUpdates=none", bad, ALLOWED, no_fetch))
        self.assertIsNotNone(decide("POST", f"{EVENTS}/import", bad, ALLOWED, no_fetch))

    def test_auto_decline_refused(self):
        ooo = json.dumps({"eventType": "outOfOffice", "outOfOfficeProperties": {"autoDeclineMode": "declineAllConflictingInvitations"}})
        quiet = json.dumps({"eventType": "outOfOffice", "outOfOfficeProperties": {"autoDeclineMode": "declineNone"}})
        self.assertIsNotNone(decide("POST", EVENTS, ooo, ALLOWED, no_fetch))
        self.assertIsNone(decide("POST", EVENTS, quiet, ALLOWED, no_fetch))

    def test_patch_adding_unlisted_attendee_refused_even_silently(self):
        existing = event(["me@example.net", "friend@example.com"])
        body = json.dumps({"attendees": existing["attendees"] + [{"email": "x@evil.test"}]})
        reason = decide("PATCH", f"{EVENT}?sendUpdates=none", body, ALLOWED, lambda: existing)
        self.assertIn("x@evil.test", reason)

    def test_patch_notifying_existing_unlisted_attendee_needs_none(self):
        existing = event(["me@example.net", "boss@corp.test"])
        body = json.dumps({"summary": "moved"})
        self.assertIn("boss@corp.test", decide("PATCH", f"{EVENT}?sendUpdates=all", body, ALLOWED, lambda: existing))
        self.assertIsNotNone(decide("PATCH", EVENT, body, ALLOWED, lambda: existing))
        self.assertIsNone(decide("PATCH", f"{EVENT}?sendUpdates=none", body, ALLOWED, lambda: existing))

    def test_patch_among_allowed_notifies(self):
        existing = event(["me@example.net", "friend@example.com"])
        self.assertIsNone(decide("PATCH", f"{EVENT}?sendUpdates=all", "{}", ALLOWED, lambda: existing))

    def test_removed_unlisted_attendee_counts_as_notified(self):
        existing = event(["me@example.net", "boss@corp.test"])
        body = json.dumps({"attendees": [{"email": "me@example.net", "self": True}]})
        self.assertIsNotNone(decide("PATCH", f"{EVENT}?sendUpdates=all", body, ALLOWED, lambda: existing))

    def test_rsvp_note_to_unlisted_organizer_refused(self):
        existing = event(["me@example.net"], organizer="boss@corp.test")
        rsvp = [{"email": "me@example.net", "self": True, "responseStatus": "accepted", "comment": "secret"}]
        body = json.dumps({"attendees": rsvp})
        self.assertIn("boss@corp.test", decide("PATCH", f"{EVENT}?sendUpdates=none", body, ALLOWED, lambda: existing))
        rsvp[0].pop("comment")
        self.assertIsNone(decide("PATCH", f"{EVENT}?sendUpdates=none", json.dumps({"attendees": rsvp}), ALLOWED, lambda: existing))

    def test_moving_auto_declining_event_refused(self):
        existing = event(eventType="focusTime", focusTimeProperties={"autoDeclineMode": "declineOnlyNewConflictingInvitations"})
        self.assertIsNotNone(decide("PATCH", f"{EVENT}?sendUpdates=none", "{}", ALLOWED, lambda: existing))

    def test_delete_notifying_unlisted_needs_none(self):
        existing = event(["me@example.net", "boss@corp.test"])
        self.assertIsNotNone(decide("DELETE", f"{EVENT}?sendUpdates=all", None, ALLOWED, lambda: existing))
        self.assertIsNone(decide("DELETE", f"{EVENT}?sendUpdates=none", None, ALLOWED, lambda: existing))

    def test_unreadable_event_refused(self):
        self.assertIsNotNone(decide("PATCH", f"{EVENT}?sendUpdates=none", "{}", ALLOWED, lambda: None))

    def test_unknown_calendar_writes_refused(self):
        base = "https://www.googleapis.com/calendar/v3"
        for method, path in [
            ("POST", "calendars/primary/events/quickAdd?text=lunch"),
            ("POST", "calendars/primary/events/ev1/move?destination=x"),
            ("POST", "calendars/primary/acl"),
            ("POST", "calendars/primary/clear"),
            ("POST", "calendars/primary/events/watch"),
        ]:
            self.assertIsNotNone(decide(method, f"{base}/{path}", "{}", ALLOWED, no_fetch), path)

    def test_calendar_quiet_writes_pass(self):
        base = "https://www.googleapis.com/calendar/v3"
        self.assertIsNone(decide("POST", f"{base}/calendars", "{}", ALLOWED, no_fetch))

    def test_other_services_untouched(self):
        url = "https://tasks.googleapis.com/tasks/v1/lists/l1/tasks"
        self.assertIsNone(decide("POST", url, "{}", ALLOWED, no_fetch))


class InstalledTest(unittest.TestCase):
    """Through the real client stack: discovery client -> AuthorizedHttp -> guard."""

    def setUp(self):
        self.original = google_auth_httplib2.AuthorizedHttp.request
        self.addCleanup(setattr, google_auth_httplib2.AuthorizedHttp, "request", self.original)
        self.assertTrue(recipient_guard.install(["friend@example.com"], own="me@example.net"))

    def service(self, name, version, responses):
        http = google_auth_httplib2.AuthorizedHttp(Credentials(token="t"), http=HttpMockSequence(responses))
        return build(name, version, http=http, static_discovery=True), http.http

    def test_send_to_unlisted_raises_and_reaches_nothing(self):
        gmail, transport = self.service("gmail", "v1", [])
        raw = base64.urlsafe_b64encode(mail(["To: x@evil.test"]).encode()).decode()
        with self.assertRaises(UserInputError) as caught:
            gmail.users().messages().send(userId="me", body={"raw": raw}).execute()
        self.assertIn("x@evil.test", str(caught.exception))
        self.assertEqual(transport._iterable, [])

    def test_send_to_listed_goes_out(self):
        gmail, _ = self.service("gmail", "v1", [({"status": "200"}, '{"id": "m1"}')])
        raw = base64.urlsafe_b64encode(mail(["To: friend@example.com"]).encode()).decode()
        self.assertEqual(gmail.users().messages().send(userId="me", body={"raw": raw}).execute(), {"id": "m1"})

    def test_batched_write_raises(self):
        gmail, _ = self.service("gmail", "v1", [])
        batch = gmail.new_batch_http_request()
        batch.add(gmail.users().messages().modify(userId="me", id="m1", body={"addLabelIds": ["X"]}))
        with self.assertRaises(UserInputError):
            batch.execute()

    def test_calendar_patch_fetches_then_refuses(self):
        existing = json.dumps(event(["me@example.net", "boss@corp.test"]))
        calendar, _ = self.service("calendar", "v3", [({"status": "200"}, existing)])
        request = calendar.events().patch(calendarId="primary", eventId="ev1", body={"summary": "x"}, sendUpdates="all")
        with self.assertRaises(UserInputError) as caught:
            request.execute()
        self.assertIn("boss@corp.test", str(caught.exception))

    def test_empty_list_installs_nothing(self):
        self.assertFalse(recipient_guard.install([], own="me@example.net"))


class LaunchTest(unittest.TestCase):
    def test_env_is_required_and_strict(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ValueError):
                launch.allowed_from_env()
        for bad in ("{}", '"a@b.c"', "[1]", "not json"):
            with mock.patch.dict(os.environ, {"LETTUCE_ALLOWED_RECIPIENTS": bad}):
                with self.assertRaises(ValueError):
                    launch.allowed_from_env()
        with mock.patch.dict(os.environ, {"LETTUCE_ALLOWED_RECIPIENTS": '["a@b.c"]'}):
            self.assertEqual(launch.allowed_from_env(), ["a@b.c"])


class SupervisorTest(unittest.TestCase):
    policy = {
        "enabled": True,
        "email": "me@example.net",
        "permissions": ["gmail:send"],
        "clientId": "id",
        "clientSecret": "secret",
    }

    def read(self, extra):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump({**self.policy, **extra}, handle)
        self.addCleanup(os.unlink, handle.name)
        with mock.patch.object(supervisor, "POLICY", handle.name):
            return supervisor.read_policy()

    def test_list_reaches_the_launcher(self):
        policy = self.read({"allowedRecipients": ["friend@example.com"]})
        self.assertEqual(json.loads(supervisor.environment_for(policy)["LETTUCE_ALLOWED_RECIPIENTS"]), ["friend@example.com"])
        self.assertEqual(supervisor.command_for(policy)[1], supervisor.LAUNCHER)

    def test_absent_list_means_none(self):
        self.assertEqual(self.read({})["allowedRecipients"], [])

    def test_malformed_list_serves_nothing(self):
        self.assertIsNone(self.read({"allowedRecipients": "friend@example.com"}))
        self.assertIsNone(self.read({"allowedRecipients": [1]}))


if __name__ == "__main__":
    unittest.main()
