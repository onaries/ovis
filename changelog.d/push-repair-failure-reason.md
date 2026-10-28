### Fixed
- When **Turn alerts on again** cannot make a push subscription, the alerts notice and Settings now
  say why: the browser would not make one (in Brave, its push service is off until **Use Google
  services for push messaging** is on), the page's service worker is not running, or the PC did not
  take it. Before, the button only flickered and the notice came back unchanged.
- The alerts notice can be dismissed. It stays closed on that device for the same problem, and
  shows again for a different one or after alerts work again. Settings still shows the problem.
