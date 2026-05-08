import { auth, db, storage, logoutUser } from "./auth.js";
import { onAuthStateChanged, updateProfile } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

function el(id) {
  return document.getElementById(id);
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  return 0;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function setText(id, value) {
  const e = el(id);
  if (e) e.textContent = value;
}

function setHidden(id, hidden) {
  const e = el(id);
  if (e) e.classList.toggle("hidden", hidden);
}

function setAvatar(divId, url) {
  const p = el(divId);
  if (!p) return;
  p.style.backgroundImage = `url('${url.replace(/'/g, "\\'")}')`;
}

function computeXp({ fieldsCount, scansCount, assistantMsgs }) {
  return fieldsCount * 120 + scansCount * 60 + assistantMsgs * 20;
}

function levelFromXp(xp) {
  if (xp >= 6000) return { name: "Elite", pct: 100 };
  if (xp >= 3000) return { name: "Advanced", pct: ((xp - 3000) / 3000) * 100 };
  if (xp >= 1200) return { name: "Pro", pct: ((xp - 1200) / 1800) * 100 };
  if (xp >= 300) return { name: "Rising", pct: ((xp - 300) / 900) * 100 };
  return { name: "Getting started", pct: (xp / 300) * 100 };
}

function safePercent(n) {
  if (!Number.isFinite(n)) return "--";
  return `${clamp(Math.round(n), 0, 100)}%`;
}

function toast(title, html, confirmText = "OK") {
  const Swal = window.Swal;
  if (Swal) {
    Swal.fire({ title, html, icon: "info", confirmButtonColor: "#10b981", confirmButtonText: confirmText });
  } else {
    window.alert(title);
  }
}

function wireStaticProfileUi() {
  el("logout-btn-trigger")?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const Swal = window.Swal;
    if (Swal) {
      const r = await Swal.fire({
        title: "Log out?",
        text: "You will need to sign in again to access your farm data.",
        icon: "question",
        showCancelButton: true,
        confirmButtonColor: "#10b981",
        cancelButtonColor: "#64748b",
        confirmButtonText: "Yes, log out",
        cancelButtonText: "Cancel",
        reverseButtons: true,
      });
      if (r.isConfirmed) await logoutUser();
    } else if (window.confirm("Are you sure you want to log out?")) {
      await logoutUser();
    }
  });

  el("profile-backup-info")?.addEventListener("click", () => {
    toast(
      "Data sync",
      "Fields, scans, recommendations, and weather logs are stored in your Firebase project and sync automatically when you are online. Use the same account on any device to pick up where you left off.",
    );
  });

  el("profile-help-btn")?.addEventListener("click", () => {
    toast(
      "Get started",
      "<ul style=\"text-align:left;margin:.5em 0 0 1em;padding:0;\"><li>Add a field under <b>Fields</b></li><li>Run a crop scan</li><li>Open <b>Weather</b> for location-based forecasts</li><li>Use <b>AI Assistant</b> for guidance from your real farm data</li></ul>",
      "Got it",
    );
  });

  el("profile-security-btn")?.addEventListener("click", () => {
    const Swal = window.Swal;
    if (Swal) {
      Swal.fire({
        title: "Account security",
        html: "You sign in with Firebase Authentication (email or Google). To change your password, use <b>Forgot password</b> on the login page, or your Google account security settings.",
        icon: "info",
        showCancelButton: true,
        confirmButtonColor: "#10b981",
        cancelButtonColor: "#64748b",
        confirmButtonText: "Open login",
        cancelButtonText: "Close",
      }).then((r) => {
        if (r.isConfirmed) window.location.href = "login.html";
      });
    } else {
      if (window.confirm("Open login page for password help?")) window.location.href = "login.html";
    }
  });

  el("profile-plan-cta")?.addEventListener("click", () => {
    toast(
      "Plans",
      "Billing and paid tiers are not wired in this build. All core farm features use your Firebase project as configured.",
    );
  });
}

function attachProfileData(user) {
  const unsubs = [];
  const fallbackName = user.displayName || (user.email ? user.email.split("@")[0] : "Farmer");
  const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(fallbackName)}&background=10B981&color=fff`;

  setText("user-email-display", user.email || "--");

  setAvatar("profile-picture", user.photoURL || fallbackAvatar);

  const camBtn = document.querySelector(".ph-cam-btn");
  const upload = document.createElement("input");
  upload.type = "file";
  upload.accept = "image/*";
  upload.style.display = "none";
  document.body.appendChild(upload);

  const onCam = () => upload.click();
  camBtn?.addEventListener("click", onCam);

  const onFile = async () => {
    const file = upload.files && upload.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      window.alert("Please choose an image under 5MB.");
      return;
    }
    try {
      const storageRef = ref(storage, `avatars/${user.uid}/${Date.now()}_${file.name}`);
      const task = uploadBytesResumable(storageRef, file);
      await new Promise((resolve, reject) => {
        task.on("state_changed", null, reject, resolve);
      });
      const url = await getDownloadURL(task.snapshot.ref);
      await setDoc(doc(db, "users", user.uid), { photoURL: url, updatedAt: serverTimestamp() }, { merge: true });
      await updateProfile(user, { photoURL: url });
      setAvatar("profile-picture", url);
    } catch (e) {
      console.error(e);
      window.alert(`Avatar upload failed: ${e.message}`);
    } finally {
      upload.value = "";
    }
  };
  upload.addEventListener("change", onFile);

  unsubs.push(() => {
    camBtn?.removeEventListener("click", onCam);
    upload.removeEventListener("change", onFile);
    upload.remove();
  });

  unsubs.push(
    onSnapshot(doc(db, "users", user.uid), (snap) => {
      const data = snap.exists() ? snap.data() : {};
      const name = data.name || user.displayName || fallbackName;
      setText("user-display-name", name);
      setText("profile-location", data.village || "Location not set");
      setText("profile-phone", data.phone || user.phoneNumber || "Phone not set");
      setHidden("verified-badge", !data.isVerified);

      const avatarUrl = data.photoURL || user.photoURL || fallbackAvatar;
      setAvatar("profile-picture", avatarUrl);
    }),
  );

  let fieldsCount = 0;
  let totalArea = 0;
  let scans = [];
  let assistantMsgs = 0;

  const rerender = () => {
    setText("profile-stat-fields", fieldsCount ? String(fieldsCount) : "0");
    setText("profile-stat-fields-sub", fieldsCount ? "Active" : "No fields");
    setText("profile-stat-area", fieldsCount ? totalArea.toFixed(1) : "--");

    const recent30 = scans.filter((s) => Date.now() - tsToMs(s.createdAt) <= 30 * 86400000);
    if (!recent30.length) {
      setText("profile-stat-productivity", "--");
      setText("profile-stat-productivity-sub", "No scan data");
    } else {
      const good = recent30.filter((s) => s?.severity?.level === "good").length;
      const pct = (good / recent30.length) * 100;
      setText("profile-stat-productivity", safePercent(pct));
      setText("profile-stat-productivity-sub", "Based on scan outcomes");
    }

    if (!fieldsCount) {
      setText("profile-stat-sust", "--");
      setText("profile-stat-sust-sub", "Add fields first");
      setText("profile-stat-ai", "--");
      setText("profile-stat-ai-sub", "Not enough data");
    } else {
      const fieldsWithScans = new Set(scans.map((s) => s.fieldId).filter(Boolean)).size;
      const coverage = (fieldsWithScans / fieldsCount) * 100;
      setText("profile-stat-ai", safePercent(coverage));
      setText("profile-stat-ai-sub", "Field coverage");

      setText("profile-stat-sust", "--");
      setText("profile-stat-sust-sub", "Awaiting sensor logs");
    }

    const xp = computeXp({ fieldsCount, scansCount: scans.length, assistantMsgs });
    const level = levelFromXp(xp);
    setText("profile-level-name", level.name);
    setText("profile-xp-text", `XP ${xp.toLocaleString()}`);
    const fill = el("profile-xp-fill");
    if (fill) fill.style.width = `${clamp(level.pct, 0, 100).toFixed(0)}%`;

    const recCount = scans.length;
    setText("profile-plan-ai", recCount ? `${recCount} scans` : "—");
    setText("profile-plan-storage", "Firebase");
    setText("profile-plan-history", fieldsCount ? "Active" : "—");
    setText("profile-plan-support", "Community");
    setText("profile-plan-name", "Grow (project)");
    setText("profile-plan-valid", user.email ? `Signed in as ${user.email}` : "Connected");
  };

  unsubs.push(
    onSnapshot(query(collection(db, "fields"), where("userId", "==", user.uid), limit(200)), (snap) => {
      fieldsCount = snap.size;
      totalArea = 0;
      snap.forEach((d) => {
        const f = d.data();
        if (typeof f.areaAcres === "number") totalArea += f.areaAcres;
      });
      rerender();
    }),
  );

  unsubs.push(
    onSnapshot(query(collection(db, "crop_scans"), where("userId", "==", user.uid), limit(500)), (snap) => {
      scans = [];
      snap.forEach((d) => scans.push({ id: d.id, ...d.data() }));
      rerender();
    }),
  );

  unsubs.push(
    onSnapshot(query(collection(db, "activity_history"), where("userId", "==", user.uid), limit(500)), (snap) => {
      let count = 0;
      snap.forEach((d) => {
        const a = d.data();
        if (a.type === "assistant.message") count += 1;
      });
      assistantMsgs = count;
      rerender();
    }),
  );

  unsubs.push(
    onSnapshot(query(collection(db, "notifications"), where("userId", "==", user.uid), limit(50)), (snap) => {
      let unread = 0;
      snap.forEach((d) => {
        const n = d.data();
        if (n.read !== true) unread += 1;
      });
      const badge = el("profile-notif-badge");
      if (badge) {
        badge.textContent = String(unread);
        setHidden("profile-notif-badge", unread === 0);
      }
    }),
  );

  return () => {
    unsubs.forEach((u) => {
      try {
        u();
      } catch (e) {
        console.warn(e);
      }
    });
  };
}

let tearDownProfile = null;

function runWhenDomReady(fn) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn, { once: true });
  } else {
    fn();
  }
}

runWhenDomReady(() => {
  wireStaticProfileUi();
});

onAuthStateChanged(auth, (user) => {
  if (tearDownProfile) {
    tearDownProfile();
    tearDownProfile = null;
  }
  if (!user) {
    if (!window.location.pathname.includes("login.html")) {
      window.location.href = "login.html";
    }
    return;
  }
  tearDownProfile = attachProfileData(user);
});
