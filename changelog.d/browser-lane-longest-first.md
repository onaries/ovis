### Maintenance
- CI's parallel browser lane starts its longest scripts first, so the lane no longer ends with one
  slow script running alone for about three minutes; on the self-hosted PC the slowest CI job
  takes about 2.5 minutes less.
