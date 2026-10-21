// Page strings for every locale the one-time page can render.
//
// One plain table, one entry per locale: no template engine, no dependency, no
// lookup beyond `MESSAGES[locale]`. The page is read once, by a person holding a
// phone, so each locale is written as native sentences rather than as a
// word-for-word copy of the English ones.
//
// The remaining-time line is per-locale code instead of a shared "drop the s"
// rule: Russian has three minute forms and Chinese has one, so a `count === 1`
// check cannot serve both.

/** English is both the last-resort locale and the shape every entry follows. */
export const FALLBACK_LOCALE = 'en';

/**
 * Locales the page can render, in table order.
 * Adding one means adding a complete `MESSAGES` entry and extending the tests.
 */
export const SUPPORTED_LOCALES = Object.freeze(['en', 'ru', 'de', 'fr', 'es', 'pt', 'zh', 'ja']);

// Russian picks the minute form from the last two digits: 1 минуту, 3 минуты,
// 5 минут — with 21 минуту and 22 минуты following the same three cases, so
// `count === 1` alone is wrong from 21 onwards.
function russianForm(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'one';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
  return 'many';
}

const RUSSIAN_MINUTES = Object.freeze({ one: 'минуту', few: 'минуты', many: 'минут' });

const MESSAGES = Object.freeze({
  en: {
    reveal: 'Reveal',
    hide: 'Hide',
    save: 'Save',
    cancel: 'Cancel',
    field: 'Value',
    mismatch: 'This value does not look like the expected format. You can still save it.',
    note: 'One-time link: it works once and stops accepting input {time}.',
    remainingSoon: 'in less than a minute',
    remaining: (count) => (count === 1 ? 'in 1 minute' : `in ${count} minutes`),
    errors: {
      action: 'The form was submitted without a recognised action.',
      empty: 'This field cannot be empty.',
      busy: 'This form is already being submitted.',
      store: 'The value could not be stored: {detail}',
    },
    mismatchNote: 'Saved, but the value did not match the expected format.',
    notices: {
      saved: {
        title: 'Saved',
        text: 'The value has been stored on the host. It is not shown here and was not sent to the chat; you can close this tab.',
      },
      empty: {
        title: 'Nothing stored',
        text: 'The form was submitted empty, so no value was saved.',
      },
      cancelled: {
        title: 'Cancelled',
        text: 'This form was cancelled. Nothing was saved.',
      },
      used: {
        title: 'Link already used',
        text: 'This link has already been used once and no longer accepts input. Ask for a new link if you still need to share a value.',
      },
      expired: {
        title: 'Link expired',
        text: 'This link is too old and no longer accepts input. Ask for a new link to submit the value.',
      },
      unknown: {
        title: 'Link not recognised',
        text: 'This link does not match any open form. It may have been mistyped, or the harness may have restarted since it was created.',
      },
    },
  },

  ru: {
    reveal: 'Показать',
    hide: 'Скрыть',
    save: 'Сохранить',
    cancel: 'Отмена',
    field: 'Значение',
    mismatch: 'Не похоже на ожидаемый формат. Сохранить всё равно можно.',
    note: 'Ссылка одноразовая: она срабатывает один раз и перестаёт принимать ввод {time}.',
    remainingSoon: 'меньше чем через минуту',
    remaining: (count) => `через ${count} ${RUSSIAN_MINUTES[russianForm(count)]}`,
    errors: {
      action: 'Форма отправлена без понятного действия.',
      empty: 'Поле не может быть пустым.',
      busy: 'Эта форма уже отправляется.',
      store: 'Не удалось сохранить значение: {detail}',
    },
    mismatchNote: 'Сохранено, но значение не совпало с ожидаемым форматом.',
    notices: {
      saved: {
        title: 'Сохранено',
        text: 'Значение сохранено на хосте. Здесь оно не показывается и в чат не отправлялось; вкладку можно закрыть.',
      },
      empty: {
        title: 'Ничего не сохранено',
        text: 'Форму отправили пустой, поэтому значение не сохранилось.',
      },
      cancelled: {
        title: 'Отменено',
        text: 'Форма отменена. Ничего не сохранено.',
      },
      used: {
        title: 'Ссылка уже использована',
        text: 'Эта ссылка уже сработала один раз и больше не принимает ввод. Если значение всё ещё нужно передать, попроси новую ссылку.',
      },
      expired: {
        title: 'Ссылка истекла',
        text: 'Ссылка слишком старая и больше не принимает ввод. Попроси новую, чтобы отправить значение.',
      },
      unknown: {
        title: 'Ссылка не распознана',
        text: 'Ссылка не подходит ни к одной открытой форме. Возможно, её набрали с ошибкой или харнесс перезапускался после её создания.',
      },
    },
  },

  de: {
    reveal: 'Anzeigen',
    hide: 'Ausblenden',
    save: 'Speichern',
    cancel: 'Abbrechen',
    field: 'Wert',
    mismatch: 'Der Wert sieht nicht wie das erwartete Format aus. Du kannst ihn trotzdem speichern.',
    note: 'Einmal-Link: er funktioniert genau einmal und nimmt {time} keine Eingabe mehr an.',
    remainingSoon: 'in weniger als einer Minute',
    remaining: (count) => (count === 1 ? 'in 1 Minute' : `in ${count} Minuten`),
    errors: {
      action: 'Das Formular wurde ohne erkennbare Aktion gesendet.',
      empty: 'Dieses Feld darf nicht leer sein.',
      busy: 'Dieses Formular wird bereits gesendet.',
      store: 'Der Wert konnte nicht gespeichert werden: {detail}',
    },
    mismatchNote: 'Gespeichert, aber der Wert entsprach nicht dem erwarteten Format.',
    notices: {
      saved: {
        title: 'Gespeichert',
        text: 'Der Wert liegt jetzt auf dem Host. Er wird hier nicht angezeigt und ging nicht in den Chat; du kannst den Tab schließen.',
      },
      empty: {
        title: 'Nichts gespeichert',
        text: 'Das Formular wurde leer gesendet, deshalb wurde kein Wert gespeichert.',
      },
      cancelled: {
        title: 'Abgebrochen',
        text: 'Dieses Formular wurde abgebrochen. Es wurde nichts gespeichert.',
      },
      used: {
        title: 'Link schon benutzt',
        text: 'Dieser Link wurde bereits einmal benutzt und nimmt keine Eingabe mehr an. Frag nach einem neuen Link, wenn du den Wert noch übermitteln willst.',
      },
      expired: {
        title: 'Link abgelaufen',
        text: 'Dieser Link ist zu alt und nimmt keine Eingabe mehr an. Frag nach einem neuen Link, um den Wert zu senden.',
      },
      unknown: {
        title: 'Link unbekannt',
        text: 'Dieser Link passt zu keinem offenen Formular. Vielleicht ist er falsch getippt worden, oder das Harness wurde seither neu gestartet.',
      },
    },
  },

  fr: {
    reveal: 'Afficher',
    hide: 'Masquer',
    save: 'Enregistrer',
    cancel: 'Annuler',
    field: 'Valeur',
    mismatch: "Cette valeur ne ressemble pas au format attendu. Tu peux quand même l'enregistrer.",
    note: "Lien à usage unique : il fonctionne une fois, puis n'accepte plus de saisie {time}.",
    remainingSoon: "dans moins d'une minute",
    remaining: (count) => (count === 1 ? 'dans 1 minute' : `dans ${count} minutes`),
    errors: {
      action: 'Le formulaire a été envoyé sans action reconnue.',
      empty: 'Ce champ ne peut pas être vide.',
      busy: "Ce formulaire est déjà en cours d'envoi.",
      store: "Impossible d'enregistrer la valeur : {detail}",
    },
    mismatchNote: 'Enregistré, mais la valeur ne correspondait pas au format attendu.',
    notices: {
      saved: {
        title: 'Enregistré',
        text: "La valeur est stockée sur l'hôte. Elle n'est pas affichée ici et n'a pas été envoyée dans le chat ; tu peux fermer cet onglet.",
      },
      empty: {
        title: "Rien d'enregistré",
        text: "Le formulaire a été envoyé vide, donc aucune valeur n'a été enregistrée.",
      },
      cancelled: {
        title: 'Annulé',
        text: "Ce formulaire a été annulé. Rien n'a été enregistré.",
      },
      used: {
        title: 'Lien déjà utilisé',
        text: "Ce lien a déjà servi une fois et n'accepte plus de saisie. Demande un nouveau lien si tu dois encore transmettre une valeur.",
      },
      expired: {
        title: 'Lien expiré',
        text: "Ce lien est trop ancien et n'accepte plus de saisie. Demande un nouveau lien pour envoyer la valeur.",
      },
      unknown: {
        title: 'Lien non reconnu',
        text: "Ce lien ne correspond à aucun formulaire ouvert. Il a peut-être été mal tapé, ou le harness a redémarré depuis sa création.",
      },
    },
  },

  es: {
    reveal: 'Mostrar',
    hide: 'Ocultar',
    save: 'Guardar',
    cancel: 'Cancelar',
    field: 'Valor',
    mismatch: 'Este valor no parece tener el formato esperado. Aun así puedes guardarlo.',
    note: 'Enlace de un solo uso: funciona una vez y deja de aceptar datos {time}.',
    remainingSoon: 'en menos de un minuto',
    remaining: (count) => (count === 1 ? 'en 1 minuto' : `en ${count} minutos`),
    errors: {
      action: 'El formulario se envió sin una acción reconocida.',
      empty: 'Este campo no puede estar vacío.',
      busy: 'Este formulario ya se está enviando.',
      store: 'No se pudo guardar el valor: {detail}',
    },
    mismatchNote: 'Guardado, pero el valor no coincidía con el formato esperado.',
    notices: {
      saved: {
        title: 'Guardado',
        text: 'El valor se ha guardado en el host. No se muestra aquí y no se envió al chat; puedes cerrar esta pestaña.',
      },
      empty: {
        title: 'No se guardó nada',
        text: 'El formulario se envió vacío, así que no se guardó ningún valor.',
      },
      cancelled: {
        title: 'Cancelado',
        text: 'Este formulario se canceló. No se guardó nada.',
      },
      used: {
        title: 'Enlace ya usado',
        text: 'Este enlace ya se usó una vez y no acepta más datos. Pide otro enlace si todavía necesitas enviar el valor.',
      },
      expired: {
        title: 'Enlace caducado',
        text: 'Este enlace es demasiado antiguo y no acepta más datos. Pide otro enlace para enviar el valor.',
      },
      unknown: {
        title: 'Enlace no reconocido',
        text: 'Este enlace no corresponde a ningún formulario abierto. Puede que se haya escrito mal o que el harness se haya reiniciado desde que se creó.',
      },
    },
  },

  pt: {
    reveal: 'Mostrar',
    hide: 'Ocultar',
    save: 'Salvar',
    cancel: 'Cancelar',
    field: 'Valor',
    mismatch: 'Este valor não parece estar no formato esperado. Você ainda pode salvá-lo.',
    note: 'Link de uso único: funciona uma vez e para de aceitar dados {time}.',
    remainingSoon: 'em menos de um minuto',
    remaining: (count) => (count === 1 ? 'em 1 minuto' : `em ${count} minutos`),
    errors: {
      action: 'O formulário foi enviado sem uma ação reconhecida.',
      empty: 'Este campo não pode ficar vazio.',
      busy: 'Este formulário já está sendo enviado.',
      store: 'Não foi possível salvar o valor: {detail}',
    },
    mismatchNote: 'Salvo, mas o valor não correspondia ao formato esperado.',
    notices: {
      saved: {
        title: 'Salvo',
        text: 'O valor foi guardado no host. Ele não aparece aqui e não foi enviado ao chat; você pode fechar esta aba.',
      },
      empty: {
        title: 'Nada foi salvo',
        text: 'O formulário foi enviado vazio, então nenhum valor foi guardado.',
      },
      cancelled: {
        title: 'Cancelado',
        text: 'Este formulário foi cancelado. Nada foi salvo.',
      },
      used: {
        title: 'Link já usado',
        text: 'Este link já foi usado uma vez e não aceita mais dados. Peça um novo link se ainda precisar enviar o valor.',
      },
      expired: {
        title: 'Link expirado',
        text: 'Este link é antigo demais e não aceita mais dados. Peça um novo link para enviar o valor.',
      },
      unknown: {
        title: 'Link não reconhecido',
        text: 'Este link não corresponde a nenhum formulário aberto. Pode ter sido digitado errado, ou o harness pode ter reiniciado desde que ele foi criado.',
      },
    },
  },

  zh: {
    reveal: '显示',
    hide: '隐藏',
    save: '保存',
    cancel: '取消',
    field: '值',
    mismatch: '看起来不是预期的格式，不过仍然可以保存。',
    note: '一次性链接：只能用一次，{time}就会停止接受输入。',
    remainingSoon: '不到一分钟后',
    remaining: (count) => `${count} 分钟后`,
    errors: {
      action: '表单提交时没有可识别的操作。',
      empty: '这一栏不能为空。',
      busy: '这个表单正在提交中。',
      store: '无法保存这个值：{detail}',
    },
    mismatchNote: '已保存，但值与预期格式不符。',
    notices: {
      saved: {
        title: '已保存',
        text: '值已保存到主机上。这里不显示它，也没有发送到聊天；你可以关闭这个标签页。',
      },
      empty: {
        title: '没有保存任何内容',
        text: '表单是空着提交的，所以没有保存值。',
      },
      cancelled: {
        title: '已取消',
        text: '这个表单已取消，没有保存任何内容。',
      },
      used: {
        title: '链接已用过',
        text: '这个链接已经用过一次，不再接受输入。如果还需要传值，请再要一个新链接。',
      },
      expired: {
        title: '链接已过期',
        text: '这个链接太旧了，不再接受输入。请再要一个新链接来提交值。',
      },
      unknown: {
        title: '链接无法识别',
        text: '这个链接不对应任何打开的表单。可能是打错了，也可能是它创建之后 harness 重启过。',
      },
    },
  },

  ja: {
    reveal: '表示',
    hide: '隠す',
    save: '保存',
    cancel: 'キャンセル',
    field: '値',
    mismatch: '期待する形式と違うようです。このまま保存してもかまいません。',
    note: '1回だけ使えるリンクです。{time}に入力を受け付けなくなります。',
    remainingSoon: '1分以内',
    remaining: (count) => `${count}分後`,
    errors: {
      action: 'フォームが不明な操作で送信されました。',
      empty: 'この欄は空にできません。',
      busy: 'このフォームは送信中です。',
      store: '値を保存できませんでした: {detail}',
    },
    mismatchNote: '保存しましたが、値は期待する形式と一致しませんでした。',
    notices: {
      saved: {
        title: '保存しました',
        text: '値はホストに保存されました。ここには表示されず、チャットにも送られていません。このタブは閉じてかまいません。',
      },
      empty: {
        title: '保存されていません',
        text: 'フォームが空のまま送信されたため、値は保存されていません。',
      },
      cancelled: {
        title: 'キャンセルしました',
        text: 'このフォームはキャンセルされました。何も保存されていません。',
      },
      used: {
        title: 'リンクは使用済みです',
        text: 'このリンクはすでに一度使われており、入力を受け付けません。まだ値を渡す必要がある場合は、新しいリンクを依頼してください。',
      },
      expired: {
        title: 'リンクの期限切れ',
        text: 'このリンクは古すぎるため、入力を受け付けません。値を送るには新しいリンクを依頼してください。',
      },
      unknown: {
        title: 'リンクを認識できません',
        text: 'このリンクは開いているどのフォームにも一致しません。打ち間違えたか、作成後に harness が再起動した可能性があります。',
      },
    },
  },
});

/** Strings for a supported locale; anything else renders English. */
export function messagesFor(locale) {
  return MESSAGES[locale] ?? MESSAGES[FALLBACK_LOCALE];
}

/**
 * Reduce a BCP 47 tag to a supported locale by its primary subtag.
 * `de-AT` becomes `de`, `zh-CN`, `zh-TW` and `zh-Hans` all become `zh`.
 * @returns the locale, or undefined when nothing supported matches.
 */
export function normalizeLocale(tag) {
  if (typeof tag !== 'string') return undefined;
  const primary = tag.trim().toLowerCase().split('-')[0];
  return SUPPORTED_LOCALES.includes(primary) ? primary : undefined;
}

/**
 * Pick a locale from an `Accept-Language` header.
 * q-values rank the list, header order only breaks ties, and a tag we do not
 * have falls through to the next candidate instead of failing the whole header.
 * @returns the locale, or undefined when the header names nothing supported.
 */
export function localeFromAcceptLanguage(header) {
  if (typeof header !== 'string') return undefined;
  const ranked = header
    .split(',')
    .map((part, order) => {
      const [rawTag, ...params] = part.split(';');
      let quality = 1;
      for (const param of params) {
        const [key, value] = param.split('=');
        if (key.trim().toLowerCase() !== 'q') continue;
        const parsed = Number(value);
        if (Number.isFinite(parsed)) quality = parsed;
      }
      return { tag: rawTag.trim(), quality, order };
    })
    // `q=0` means "not acceptable", and `*` names no language we could serve.
    .filter((entry) => entry.tag !== '' && entry.tag !== '*' && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.order - b.order);
  for (const entry of ranked) {
    const locale = normalizeLocale(entry.tag);
    if (locale !== undefined) return locale;
  }
  return undefined;
}

/**
 * Locale for one request. An explicit `lang` (the query parameter on the form,
 * the hidden field on the post) wins over the browser header, then the plugin's
 * `defaultLocale`, then English.
 */
export function resolveLocale({ lang, acceptLanguage, defaultLocale } = {}) {
  return normalizeLocale(lang)
    ?? localeFromAcceptLanguage(acceptLanguage)
    ?? normalizeLocale(defaultLocale)
    ?? FALLBACK_LOCALE;
}

/** Fill `{name}` slots. Translations are ours, so the result is trusted text. */
export function format(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (slot, key) => (key in values ? String(values[key]) : slot));
}
