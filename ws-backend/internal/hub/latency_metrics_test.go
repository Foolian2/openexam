package hub

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	ws "github.com/coder/websocket"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

	"openexam/ws-backend/internal/metrics"
	"openexam/ws-backend/internal/protocol"
)

// observationsFor sums the observation count of every series in a histogram
// vector carrying `label` as one of its label values.
//
// Deltas, never absolute counts: these histograms are process-wide package
// vars (internal/metrics), so every other test in this package contributes to
// them and the order tests run in is not fixed. Asserting "went up by one"
// is the only form that stays true when a test is added next to it.
func observationsFor(t *testing.T, c prometheus.Collector, label string) uint64 {
	t.Helper()

	ch := make(chan prometheus.Metric, 64)
	go func() {
		c.Collect(ch)
		close(ch)
	}()

	var total uint64
	for m := range ch {
		var pb dto.Metric
		if err := m.Write(&pb); err != nil {
			t.Fatalf("write metric: %v", err)
		}
		for _, l := range pb.GetLabel() {
			if l.GetValue() == label {
				total += pb.GetHistogram().GetSampleCount()
			}
		}
	}
	return total
}

// waitForObservations polls until the label's count has grown by want.
//
// The room records an ack's latency once the write pump has put the frame on
// the wire, and a rejection's right after enqueueing it, so the client can
// read the reply before the observation lands. Reading the histogram the
// instant the reply arrives raced on fast runners.
func waitForObservations(t *testing.T, c prometheus.Collector, label string, before, want uint64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		got := observationsFor(t, c, label) - before
		if got == want {
			return
		}
		if got > want || time.Now().After(deadline) {
			t.Fatalf("got %d new %s observations, want %d", got, label, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestRoom_AnswerSave_RecordsAckLatency(t *testing.T) {
	room, _ := newTestRoom(t, newFakeRoomStore(), &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	beforeOK := observationsFor(t, metrics.AnswerAckSeconds, "ok")
	beforeRejected := observationsFor(t, metrics.AnswerAckSeconds, "rejected")

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	msg, _ := protocol.Encode(protocol.TypeAnswerSave, "req-1", protocol.AnswerSaveData{
		QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"hi"}`),
	})
	if err := student.Write(context.Background(), ws.MessageText, msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	if env := readEnvelope(t, student); env.Type != protocol.TypeAnswerAck {
		t.Fatalf("got type %q, want answer:ack", env.Type)
	}

	waitForObservations(t, metrics.AnswerAckSeconds, "ok", beforeOK, 1)
	if got := observationsFor(t, metrics.AnswerAckSeconds, "rejected") - beforeRejected; got != 0 {
		t.Fatalf("got %d new rejected observations, want 0", got)
	}
}

// A rejection must not be counted as an ack. Rejections are cheap — they
// return before touching the buffer — so folding them into the same series
// would drag the p95 down and hide exactly the slow saves the SLO alert
// exists to catch.
func TestRoom_AnswerSave_RecordsRejectionSeparately(t *testing.T) {
	room, _ := newTestRoom(t, newFakeRoomStore(), &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	beforeOK := observationsFor(t, metrics.AnswerAckSeconds, "ok")
	beforeRejected := observationsFor(t, metrics.AnswerAckSeconds, "rejected")

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	msg, _ := protocol.Encode(protocol.TypeAnswerSave, "req-1", protocol.AnswerSaveData{
		QuestionID: "another-exam-question", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"hi"}`),
	})
	if err := student.Write(context.Background(), ws.MessageText, msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	if env := readEnvelope(t, student); env.Type != protocol.TypeAnswerError {
		t.Fatalf("got type %q, want answer:error", env.Type)
	}

	waitForObservations(t, metrics.AnswerAckSeconds, "rejected", beforeRejected, 1)
	if got := observationsFor(t, metrics.AnswerAckSeconds, "ok") - beforeOK; got != 0 {
		t.Fatalf("got %d new ok observations, want 0", got)
	}
}

// The envelope type is student-controlled input. Labeling the queue histogram
// with it directly would let one client mint a new Prometheus series per
// frame, so queueLabel collapses anything it does not dispatch on to "other".
func TestRoom_InboundQueue_ClampsUnknownMessageType(t *testing.T) {
	room, _ := newTestRoom(t, newFakeRoomStore(), &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	beforePing := observationsFor(t, metrics.InboundQueueSeconds, protocol.TypePing)
	beforeOther := observationsFor(t, metrics.InboundQueueSeconds, "other")

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	for _, msgType := range []string{"totally-made-up", "another-made-up-one"} {
		msg, _ := protocol.Encode(msgType, "req-1", struct{}{})
		if err := student.Write(context.Background(), ws.MessageText, msg); err != nil {
			t.Fatalf("write %s: %v", msgType, err)
		}
	}

	// Unknown types draw no reply, so there is nothing to wait for directly.
	// A ping does reply, and the room processes inbound frames one at a time
	// on a single goroutine — so receiving the pong proves both frames above
	// were already handled.
	ping, _ := protocol.Encode(protocol.TypePing, "req-ping", struct{}{})
	if err := student.Write(context.Background(), ws.MessageText, ping); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	if env := readEnvelope(t, student); env.Type != protocol.TypePong {
		t.Fatalf("got type %q, want pong", env.Type)
	}

	if got := observationsFor(t, metrics.InboundQueueSeconds, "other") - beforeOther; got != 2 {
		t.Fatalf("got %d new other observations, want 2 (both unknown types collapsed)", got)
	}
	if got := observationsFor(t, metrics.InboundQueueSeconds, protocol.TypePing) - beforePing; got != 1 {
		t.Fatalf("got %d new ping observations, want 1", got)
	}
}
