// Package metrics holds the process-wide Prometheus collectors for
// ws-backend, registered once and incremented from wherever the event they
// describe actually happens (internal/hub, main.go). Kept as simple package
// vars, mirroring how internal/config and internal/store are consumed
// throughout this codebase — there is exactly one of each of these per
// process, so a constructor/DI wrapper would add nothing.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Registry is a dedicated registry (not the global DefaultRegisterer) so
// /metrics never picks up the client_golang default process/Go collectors
// twice if something else in the binary also touches the default registry,
// and so tests that construct multiple hubs don't panic on double
// registration. Registered explicitly in main.go's promhttp handler.
var Registry = prometheus.NewRegistry()

func init() {
	Registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
}

var (
	// ActiveRooms tracks live exam rooms — one goroutine each (see
	// internal/hub/hub.go's GetOrCreateRoom / internal/hub/room.go's run()).
	ActiveRooms = promauto.With(Registry).NewGauge(prometheus.GaugeOpts{
		Name: "openexam_ws_active_rooms",
		Help: "Number of currently running exam rooms",
	})

	// ActiveConnections tracks live WebSocket connections, labeled by kind
	// so a spike in one is distinguishable from the other (e.g. a teacher
	// leaving a monitor tab open all day vs. a burst of student joins).
	ActiveConnections = promauto.With(Registry).NewGaugeVec(prometheus.GaugeOpts{
		Name: "openexam_ws_active_connections",
		Help: "Number of currently connected WebSocket clients",
	}, []string{"kind"})

	// AsyncQueueFull counts internal/hub/async.go's offloadLossy/offloadDurable
	// hitting a full per-room queue — offloadDurable's "durable" label is the
	// fallback-to-inline-path event (see docker-compose.prod.yml's ws-backend
	// pool-sizing comment). A rising rate here means rooms are falling behind
	// their Postgres/Redis I/O, not that connections are failing outright.
	AsyncQueueFull = promauto.With(Registry).NewCounterVec(prometheus.CounterOpts{
		Name: "openexam_ws_async_queue_full_total",
		Help: "Times a room's async job queue was full",
	}, []string{"policy"})

	// OffloadFlushes counts internal/hub/room.go's offloadFlush calls (forced
	// flush on exam close / session submit), labeled by outcome.
	OffloadFlushes = promauto.With(Registry).NewCounterVec(prometheus.CounterOpts{
		Name: "openexam_ws_offload_flush_total",
		Help: "Force-flush operations triggered by exam close or session submit",
	}, []string{"outcome"})

	// AnswerAckSeconds measures the answer:save -> answer:ack round trip as the
	// server sees it: from the moment the read pump hands the frame to the room
	// channel until handleAnswerSave returns having enqueued the reply. This is
	// the SLO README.md states as "p95 WS answer-save->ack < 100 ms".
	//
	// The window deliberately includes queue wait and the monitor broadcast:
	// what it measures is how long the single room goroutine is occupied by one
	// save, which is precisely what every other student in the room waits behind.
	//
	// `outcome` separates acks from the nine rejection paths (locked, submitted,
	// expired, rate-limited, ...). Without it a room full of fast rejections
	// would flatter the histogram — a rejection is cheap, and averaging it with
	// real saves hides the tail this metric exists to expose.
	AnswerAckSeconds = promauto.With(Registry).NewHistogramVec(prometheus.HistogramOpts{
		Name:    "openexam_ws_answer_ack_seconds",
		Help:    "Time from receiving an answer:save frame to enqueueing its reply",
		Buckets: latencyBuckets,
	}, []string{"outcome"})

	// AnswerStateCheckSeconds isolates the new per-save PostgreSQL lifecycle
	// gate from queueing and Redis latency so the load run can quantify its
	// direct contribution to answer acknowledgements.
	AnswerStateCheckSeconds = promauto.With(Registry).NewHistogram(prometheus.HistogramOpts{
		Name:    "openexam_ws_answer_state_check_seconds",
		Help:    "Time spent checking authoritative PostgreSQL lifecycle state before buffering an answer",
		Buckets: latencyBuckets,
	})
	AnswerStateCheckOutcomes = promauto.With(Registry).NewCounterVec(prometheus.CounterOpts{
		Name: "openexam_ws_answer_state_check_total",
		Help: "Authoritative PostgreSQL answer lifecycle check outcomes",
	}, []string{"outcome"})

	// InboundQueueSeconds measures how long a frame sat in the room's inbound
	// channel before the room goroutine picked it up.
	//
	// Idle CPU beside a multi-second tail is queueing. Splitting it out from AnswerAckSeconds
	// separates "the room is behind" from "this save was slow".
	InboundQueueSeconds = promauto.With(Registry).NewHistogramVec(prometheus.HistogramOpts{
		Name:    "openexam_ws_inbound_queue_seconds",
		Help:    "Time an inbound frame waited in the room queue before dispatch",
		Buckets: latencyBuckets,
	}, []string{"type"})
)

// Centred on the 100ms ack SLO — five buckets below it so a healthy room is
// resolved rather than lumped into one, and a long tail above it so the
// multi-second stalls remain visible instead of
// vanishing into +Inf.
var latencyBuckets = []float64{
	.001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 10,
}
