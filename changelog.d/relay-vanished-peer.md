### Fixed
- When a phone or PC drops off the network without closing its relay connection, the hosted relay
  now ends that connection once. Before, it told the PC the phone had left again every two minutes
  and kept the PC's relay room awake until the network gave up on the connection.
