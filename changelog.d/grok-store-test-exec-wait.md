### Maintenance
- The Grok exact store lookup tests wait until their fixture process runs its own script before
  reading its open files, so a loaded CI runner no longer fails them at random.
