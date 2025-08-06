import { CountryCode } from '@enums';

import { LOCALE_SETTINGS } from './localeSettings';

const SUCCESS_INDICATORS: Record<string, string[]> = {
  // Английский (en-*)
  'en': [
    'thank you', 'thanks', 'success', 'submitted', 'confirmation', 'received',
    'successful', 'completed', 'done', 'finished', 'accepted', 'approved'
  ],
  
  // Русский (ru-*)
  'ru': [
    'спасибо', 'благодарим', 'успешно', 'отправлено', 'подтверждение', 'получено',
    'завершено', 'выполнено', 'принято', 'одобрено', 'готово'
  ],
  
  // Испанский (es-*)
  'es': [
    'gracias', 'éxito', 'enviado', 'confirmación', 'recibido',
    'completado', 'terminado', 'aceptado', 'aprobado', 'listo'
  ],
  
  // Французский (fr-*)
  'fr': [
    'merci', 'succès', 'envoyé', 'confirmation', 'reçu',
    'terminé', 'complété', 'accepté', 'approuvé', 'prêt'
  ],
  
  // Немецкий (de-*)
  'de': [
    'danke', 'erfolg', 'gesendet', 'bestätigung', 'erhalten',
    'abgeschlossen', 'fertig', 'akzeptiert', 'genehmigt', 'bereit'
  ],
  
  // Итальянский (it-*)
  'it': [
    'grazie', 'successo', 'inviato', 'conferma', 'ricevuto',
    'completato', 'finito', 'accettato', 'approvato', 'pronto'
  ],
  
  // Португальский (pt-*)
  'pt': [
    'obrigado', 'sucesso', 'enviado', 'confirmação', 'recebido',
    'concluído', 'terminado', 'aceito', 'aprovado', 'pronto'
  ],
  
  // Китайский (zh-*)
  'zh': [
    '谢谢', '成功', '已发送', '确认', '已收到',
    '完成', '结束', '已接受', '已批准', '就绪'
  ],
  
  // Японский (ja-*)
  'ja': [
    'ありがとう', '成功', '送信済み', '確認', '受信済み',
    '完了', '終了', '承認済み', '承認', '準備完了'
  ],
  
  // Корейский (ko-*)
  'ko': [
    '감사합니다', '성공', '전송됨', '확인', '수신됨',
    '완료', '종료', '승인됨', '승인', '준비됨'
  ],
  
  // Арабский (ar-*)
  'ar': [
    'شكرا', 'نجح', 'تم الإرسال', 'تأكيد', 'تم الاستلام',
    'مكتمل', 'منتهي', 'مقبول', 'معتمد', 'جاهز'
  ],
  
  // Турецкий (tr-*)
  'tr': [
    'teşekkürler', 'başarılı', 'gönderildi', 'onay', 'alındı',
    'tamamlandı', 'bitti', 'kabul edildi', 'onaylandı', 'hazır'
  ],
  
  // Польский (pl-*)
  'pl': [
    'dziękuję', 'sukces', 'wysłane', 'potwierdzenie', 'otrzymane',
    'zakończone', 'gotowe', 'zaakceptowane', 'zatwierdzone', 'gotowe'
  ],
  
  // Украинский (uk-*)
  'uk': [
    'дякую', 'успішно', 'відправлено', 'підтвердження', 'отримано',
    'завершено', 'виконано', 'прийнято', 'схвалено', 'готово'
  ],
  
  // Голландский (nl-*)
  'nl': [
    'bedankt', 'succes', 'verzonden', 'bevestiging', 'ontvangen',
    'voltooid', 'klaar', 'geaccepteerd', 'goedgekeurd', 'gereed'
  ],
  
  // Шведский (sv-*)
  'sv': [
    'tack', 'framgång', 'skickat', 'bekräftelse', 'mottaget',
    'slutfört', 'klart', 'accepterat', 'godkänt', 'redo'
  ],
  
  // Норвежский (nb-*, nn-*)
  'nb': [
    'takk', 'suksess', 'sendt', 'bekreftelse', 'mottatt',
    'fullført', 'ferdig', 'akseptert', 'godkjent', 'klar'
  ],
  
  // Датский (da-*)
  'da': [
    'tak', 'succes', 'sendt', 'bekræftelse', 'modtaget',
    'fuldført', 'færdig', 'accepteret', 'godkendt', 'klar'
  ],
  
  // Финский (fi-*)
  'fi': [
    'kiitos', 'onnistui', 'lähetetty', 'vahvistus', 'vastaanotettu',
    'valmis', 'suoritettu', 'hyväksytty', 'hyväksytty', 'valmis'
  ],
  
  // Венгерский (hu-*)
  'hu': [
    'köszönöm', 'siker', 'elküldve', 'megerősítés', 'fogadva',
    'befejezve', 'kész', 'elfogadva', 'jóváhagyva', 'kész'
  ],
  
  // Чешский (cs-*)
  'cs': [
    'děkuji', 'úspěch', 'odesláno', 'potvrzení', 'přijato',
    'dokončeno', 'hotovo', 'přijato', 'schváleno', 'připraveno'
  ],
  
  // Словацкий (sk-*)
  'sk': [
    'ďakujem', 'úspech', 'odoslané', 'potvrdenie', 'prijaté',
    'dokončené', 'hotovo', 'prijaté', 'schválené', 'pripravené'
  ],
  
  // Словенский (sl-*)
  'sl': [
    'hvala', 'uspeh', 'poslano', 'potrditev', 'prejeto',
    'dokončano', 'končano', 'sprejeto', 'odobreno', 'pripravljeno'
  ],
  
  // Хорватский (hr-*)
  'hr': [
    'hvala', 'uspjeh', 'poslano', 'potvrda', 'primljeno',
    'dovršeno', 'gotovo', 'prihvaćeno', 'odobreno', 'spremno'
  ],
  
  // Румынский (ro-*)
  'ro': [
    'mulțumesc', 'succes', 'trimis', 'confirmare', 'primit',
    'completat', 'terminat', 'acceptat', 'aprobat', 'gata'
  ],
  
  // Болгарский (bg-*)
  'bg': [
    'благодаря', 'успех', 'изпратено', 'потвърждение', 'получено',
    'завършено', 'готово', 'прието', 'одобрено', 'готово'
  ],
  
  // Греческий (el-*)
  'el': [
    'ευχαριστώ', 'επιτυχία', 'αποστάλθηκε', 'επιβεβαίωση', 'λήφθηκε',
    'ολοκληρώθηκε', 'έτοιμο', 'αποδεκτό', 'εγκεκριμένο', 'έτοιμο'
  ],
  
  // Эстонский (et-*)
  'et': [
    'aitäh', 'edu', 'saatnud', 'kinnitamine', 'vastu võetud',
    'lõpetatud', 'valmis', 'vastu võetud', 'heaks kiidetud', 'valmis'
  ],
  
  // Латышский (lv-*)
  'lv': [
    'paldies', 'panākums', 'nosūtīts', 'apstiprinājums', 'saņemts',
    'pabeigts', 'gatavs', 'pieņemts', 'apstiprināts', 'gatavs'
  ],
  
  // Литовский (lt-*)
  'lt': [
    'ačiū', 'sėkmė', 'išsiųsta', 'patvirtinimas', 'gauta',
    'baigta', 'paruošta', 'priimta', 'patvirtinta', 'paruošta'
  ],
  
  // Вьетнамский (vi-*)
  'vi': [
    'cảm ơn', 'thành công', 'đã gửi', 'xác nhận', 'đã nhận',
    'hoàn thành', 'xong', 'đã chấp nhận', 'đã phê duyệt', 'sẵn sàng'
  ],
  
  // Тайский (th-*)
  'th': [
    'ขอบคุณ', 'สำเร็จ', 'ส่งแล้ว', 'ยืนยัน', 'ได้รับแล้ว',
    'เสร็จสิ้น', 'เสร็จแล้ว', 'ยอมรับแล้ว', 'อนุมัติแล้ว', 'พร้อม'
  ],
  
  // Индонезийский (id-*)
  'id': [
    'terima kasih', 'berhasil', 'terkirim', 'konfirmasi', 'diterima',
    'selesai', 'siap', 'diterima', 'disetujui', 'siap'
  ],
  
  // Малайский (ms-*)
  'ms': [
    'terima kasih', 'berjaya', 'dihantar', 'pengesahan', 'diterima',
    'selesai', 'siap', 'diterima', 'diluluskan', 'siap'
  ],
  
  // Хинди (hi-*)
  'hi': [
    'धन्यवाद', 'सफल', 'भेजा गया', 'पुष्टि', 'प्राप्त',
    'पूर्ण', 'तैयार', 'स्वीकृत', 'अनुमोदित', 'तैयार'
  ],
  
  // Бенгальский (bn-*)
  'bn': [
    'ধন্যবাদ', 'সফল', 'পাঠানো হয়েছে', 'নিশ্চিতকরণ', 'প্রাপ্ত',
    'সম্পন্ন', 'প্রস্তুত', 'গৃহীত', 'অনুমোদিত', 'প্রস্তুত'
  ],
  
  // Урду (ur-*)
  'ur': [
    'شکریہ', 'کامیاب', 'بھیجا گیا', 'تصدیق', 'موصول',
    'مکمل', 'تیار', 'قبول', 'منظور', 'تیار'
  ],
  
  // Персидский (fa-*)
  'fa': [
    'متشکرم', 'موفق', 'ارسال شد', 'تأیید', 'دریافت شد',
    'تکمیل شد', 'آماده', 'پذیرفته شد', 'تأیید شد', 'آماده'
  ],
  
  // Иврит (he-*)
  'he': [
    'תודה', 'הצלחה', 'נשלח', 'אישור', 'התקבל',
    'הושלם', 'מוכן', 'אושר', 'אושר', 'מוכן'
  ]
};

export function validateCountryCodeMapping(): {
  missingInLocaleSettings: CountryCode[];
  extraInLocaleSettings: string[];
} {
  const countryCodes = Object.values(CountryCode);
  const localeSettingsKeys = Object.keys(LOCALE_SETTINGS);
  
  const missingInLocaleSettings = countryCodes.filter(
    code => !localeSettingsKeys.includes(code)
  );
  
  const extraInLocaleSettings = localeSettingsKeys.filter(
    key => !countryCodes.includes(key as CountryCode)
  );
  
  return {
    missingInLocaleSettings,
    extraInLocaleSettings
  };
}

export function getSuccessIndicatorsForGeo(geo: CountryCode): string[] {
  const localeSettings = LOCALE_SETTINGS[geo] || LOCALE_SETTINGS.ALL;
  const locale = localeSettings.locale;
  
  const primaryLanguage = locale.split('-')[0].toLowerCase();  
  const indicators = SUCCESS_INDICATORS[primaryLanguage] || SUCCESS_INDICATORS['en'];
  
  return indicators;
}

export async function checkSuccessIndicators(page: any, geo: CountryCode): Promise<{
  hasSuccessIndicators: boolean;
  indicators: string[];
  pageText: string;
}> {
  const indicators = getSuccessIndicatorsForGeo(geo);
  
  const result = await page.evaluate((indicators: string[]) => {
    const pageText = document.body?.textContent?.toLowerCase() || '';
    const foundIndicators = indicators.filter(indicator => 
      pageText.includes(indicator.toLowerCase())
    );
    
    return {
      hasSuccessIndicators: foundIndicators.length > 0,
      indicators: foundIndicators,
      pageText: pageText.substring(0, 200)
    };
  }, indicators);
  
  return result;
} 