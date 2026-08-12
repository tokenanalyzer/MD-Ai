import React, { useEffect, useRef } from "react";
import { View, StyleSheet, AppState } from "react-native";
import { Panel } from "../../components/Panel";
import { SectionLabel } from "../../components/SectionLabel";
import { MetricTile } from "../../components/MetricTile";
import { EmptyState } from "../../components/EmptyState";
import { useSystemStatusStore } from "../../state/systemStatusStore";

const REFRESH_INTERVAL_MS = 15000;

function fmtMs(ms?: number): string {
  return ms === undefined ? "—" : `${ms}ms`;
}

/**
 * M6 SYSTEM STATUS panel — every value is a real field from the existing
 * `/health` telemetry endpoint (core/observability/health.ts): backend
 * process state, Postgres/Redis latency, queue depth, provider
 * availability comes from the Models screen instead (its own real data,
 * not duplicated here). Polls on an interval since health isn't
 * event-pushed data, and pauses while the app is backgrounded.
 */
export function SystemStatus() {
  const { report, loading, error, refresh } = useSystemStatusStore();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void refresh();
    intervalRef.current = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      sub.remove();
    };
  }, [refresh]);

  return (
    <Panel accent={report?.status === "ok" ? "green" : report?.status === "degraded" ? "cyan" : "danger"}>
      <SectionLabel>System Status</SectionLabel>
      {!report && loading && <EmptyState kind="loading" message="Loading system status…" />}
      {!report && error && <EmptyState kind="error" message="Couldn't reach the backend" detail={error} />}
      {report && (
        <View style={styles.grid}>
          <MetricTile
            label="Backend"
            value={report.status === "ok" ? "Healthy" : report.status === "degraded" ? "Degraded" : "Error"}
            status={report.status === "ok" ? "connected" : report.status === "degraded" ? "working" : "error"}
          />
          <MetricTile
            label="Database"
            value={report.postgres.ok ? "Connected" : "Unreachable"}
            status={report.postgres.ok ? "connected" : "error"}
            hint={report.postgres.ok ? fmtMs(report.postgres.latencyMs) : report.postgres.error}
          />
          <MetricTile
            label="Redis / Queue"
            value={report.redis.ok ? "Connected" : "Unreachable"}
            status={report.redis.ok ? "connected" : "error"}
            hint={report.redis.ok ? fmtMs(report.redis.latencyMs) : report.redis.error}
          />
          <MetricTile
            label="Queue depth"
            value={String(report.queues.reduce((sum, q) => sum + q.waiting + q.active, 0))}
            hint={`${report.queues.reduce((sum, q) => sum + q.workerCount, 0)} worker(s)`}
          />
          <MetricTile label="CPU load (1m)" value={report.cpu.loadavg1.toFixed(2)} hint={`${report.cpu.cpuCount} core(s)`} />
          <MetricTile
            label="Memory"
            value={`${report.memory.processRssMb}MB`}
            hint={`${report.memory.systemFreeMb}MB free of ${report.memory.systemTotalMb}MB`}
          />
        </View>
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
});
