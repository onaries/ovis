### Maintenance
- The Windows plugin tests remove their scratch folder again while Windows still holds a file in
  it for a moment after the processes they started are gone, instead of failing a passed test on
  `EPERM`.
