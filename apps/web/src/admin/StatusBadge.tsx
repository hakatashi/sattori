import type { JobStatus } from "@sattori/shared";
import styles from "./statusBadge.module.css";

export function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={`${styles.badge} ${styles[status]}`}>{status}</span>;
}
