/**
 * GitHub Pages "project" sites live under https://<user>.github.io/<repo>/.
 * Without a <base> tag, some navigations resolve href="profile.html" to
 * https://<user>.github.io/profile.html (wrong) instead of .../<repo>/profile.html.
 * Chrome may then show errors, warnings, or odd interstitials.
 */
(function () {
  var host = location.hostname || "";
  if (!host.endsWith("github.io")) return;
  var first = location.pathname.split("/").filter(Boolean)[0];
  if (!first || first.indexOf(".") !== -1) return;
  var base = document.createElement("base");
  base.href = "/" + first + "/";
  var head = document.head || document.getElementsByTagName("head")[0];
  if (head) head.insertBefore(base, head.firstChild);
})();
