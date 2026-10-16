"""Checks of the Firestore stand-in itself (tests/stubs/firebase-firestore.js).

The browser tests are only as good as the stub, so the behaviours they lean on
are pinned here: server times appear only at commit, writes wait while
offline, refusals and reads can be forced, and counts are kept.
"""
import unittest

import harness as h
from base import Base, FIRESTORE


class TestStub(Base):
    def setUp(self):
        super().setUp()
        self.voter()

    def test_server_time_is_null_while_pending_and_real_after_commit(self):
        r = self.fs("""
            const db = fs.getFirestore();
            const ref = fs.doc(db, 'x', 'a');
            const seen = [];
            fs.onSnapshot(ref, { includeMetadataChanges: true }, (s) => seen.push([s.metadata.hasPendingWrites, s.exists() ? s.data().t : 'none']));
            await new Promise((r) => setTimeout(r, 10));
            await fs.setDoc(ref, { t: fs.serverTimestamp() });
            await new Promise((r) => setTimeout(r, 10));
            return seen;""")
        self.assertIn([True, None], r)
        self.assertFalse(r[-1][0])
        self.assertIsInstance(r[-1][1]["seconds"], int)

    def test_server_time_inside_an_array_is_refused(self):
        r = self.fs("""
            try { await fs.setDoc(fs.doc(fs.getFirestore(), 'x/b'), { list: [{ t: fs.serverTimestamp() }] }); return 'ok'; }
            catch (e) { return e.code; }""")
        self.assertEqual(r, "invalid-argument")

    def test_field_path_update_and_delete_field(self):
        h.seed(self.page, "config/live", {"results": {"a-b.c": {"pos": 0}, "z": {"pos": 1}}})
        self.fs("""
            const ref = fs.doc(fs.getFirestore(), 'config/live');
            await fs.updateDoc(ref, new fs.FieldPath('results', 'a-b.c', 'result'), { ok: 1 }, new fs.FieldPath('results', 'z'), fs.deleteField());""")
        self.assertEqual(h.get(self.page, "config/live"), {"results": {"a-b.c": {"pos": 0, "result": {"ok": 1}}}})

    def test_update_of_a_missing_document_is_not_found(self):
        r = self.fs("""
            try { await fs.updateDoc(fs.doc(fs.getFirestore(), 'config/nope'), { a: 1 }); return 'ok'; }
            catch (e) { return e.code; }""")
        self.assertEqual(r, "not-found")

    def test_offline_batch_waits_and_transaction_fails(self):
        self.page.evaluate("window.__store.offline(true)")
        r = self.fs("""
            const db = fs.getFirestore();
            const b = fs.writeBatch(db); b.set(fs.doc(db, 'x/c'), { a: 1 });
            let done = false; b.commit().then(() => { done = true; });
            await new Promise((r) => setTimeout(r, 30));
            let tx; try { await fs.runTransaction(db, async (t) => { await t.get(fs.doc(db, 'x/c')); }); tx = 'ok'; } catch (e) { tx = e.code; }
            let srv; try { await fs.getDocFromServer(fs.doc(db, 'x/c')); srv = 'ok'; } catch (e) { srv = e.code; }
            return { done, tx, srv, local: window.__store.local('x/c'), server: window.__store.get('x/c') };""")
        self.assertEqual(r, {"done": False, "tx": "unavailable", "srv": "unavailable", "local": {"a": 1}, "server": None})
        self.page.evaluate("window.__store.offline(false)")
        self.page.wait_for_function("() => window.__store.get('x/c') !== null")

    def test_fail_refuses_listeners_reads_and_writes(self):
        self.page.evaluate("window.__store.fail('log', 'permission-denied')")
        r = self.fs("""
            const db = fs.getFirestore();
            const out = {};
            try { await fs.getDocs(fs.collection(db, 'log')); out.read = 'ok'; } catch (e) { out.read = e.code; }
            const b = fs.writeBatch(db); b.set(fs.doc(db, 'polls/q'), { a: 1 }); b.set(fs.doc(db, 'log/1'), { a: 1 });
            try { await b.commit(); out.write = 'ok'; } catch (e) { out.write = e.code; }
            out.listen = await new Promise((res) => fs.onSnapshot(fs.collection(db, 'log'), () => res('ok'), (e) => res(e.code)));
            out.poll = window.__store.get('polls/q');
            return out;""")
        self.assertEqual(r, {"read": "permission-denied", "write": "permission-denied", "listen": "permission-denied", "poll": None})

    def test_queries_and_read_counts(self):
        for i in range(5):
            h.seed(self.page, f"polls/q{i}", {"status": "open" if i == 3 else "closed", "order": i})
        self.page.wait_for_timeout(100)   # let the page's own listeners settle first
        self.page.evaluate("window.__store.resetCounts()")
        r = self.fs("""
            const db = fs.getFirestore();
            const s = await fs.getDocs(fs.query(fs.collection(db, 'polls'), fs.where('status', '==', 'open')));
            const t = await fs.getDocs(fs.query(fs.collection(db, 'polls'), fs.orderBy('order', 'desc'), fs.limit(2)));
            return [s.docs.map((d) => d.id), t.docs.map((d) => d.id), window.__store.reads('polls/')];""")
        self.assertEqual(r, [["q3"], ["q4", "q3"], 3])

    def test_stall_holds_one_time_reads_too(self):
        h.seed(self.page, "polls/s1/votes/a", {"slug": "a"})
        self.page.evaluate("window.__store.stall('polls/s1/votes')")
        self.page.evaluate("""() => { window.__got = null; import('%s').then((fs) =>
            fs.getDocsFromServer(fs.collection(fs.getFirestore(), 'polls/s1/votes')).then((s) => { window.__got = s.size; })); }""" % FIRESTORE)
        self.page.wait_for_timeout(100)
        self.assertIsNone(self.page.evaluate("window.__got"))
        self.page.evaluate("window.__store.release('polls/s1/votes')")
        self.page.wait_for_function("() => window.__got === 1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
