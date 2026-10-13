# Source after production-compose.sh. Publish actual configured PITR state.
metrics_dir=./monitoring-data/textfile-collector
if [ -d "$metrics_dir" ]; then
  pitr_enabled=0
  [ "$walg_backend" != sftp ] || pitr_enabled=1
  metrics_tmp=$(mktemp "$metrics_dir/.pitr_state.XXXXXX")
  printf '# HELP openexam_pitr_enabled Whether SFTP PITR is configured\n# TYPE openexam_pitr_enabled gauge\nopenexam_pitr_enabled %s\n' "$pitr_enabled" > "$metrics_tmp"
  chmod 644 "$metrics_tmp"
  mv "$metrics_tmp" "$metrics_dir/pitr_state.prom"
fi
