"""Обработчики команд Telegram-бота."""

from __future__ import annotations

import html
import logging
from pathlib import Path

import aiohttp
from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.types import FSInputFile
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (
    BotCommand,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    MenuButtonWebApp,
    Message,
    WebAppInfo,
)

from .config import config

log = logging.getLogger(__name__)

router = Router()


def escape(text: str) -> str:
    """Экранирует текст для HTML-режима Telegram."""
    return html.escape(str(text), quote=False)

DESCRIPTION = (
    "🌟 <b>Официальный сервис для продаж</b>\n\n"
    "Безопасные сделки по всему миру: валюты RUB, USD, EUR, KZT, BYN, UAH.\n"
    "Сайт — FunPay.com\n\n"
    "Покупайте и продавайте NFT-подарки и товары через эскроу FunPay."
)

MANAGER_NAME = config.manager_username or "FunpayManagerRelayer"
MANAGER_URL = f"https://t.me/{MANAGER_NAME}"

WELCOME = (
    "❝ <b>👋 Добро пожаловать в FunPay Deal!</b>\n"
    "\n"
    "Ваши сделки теперь под защитой.\n"
    "\n"
    "🔐 <b>Как это работает:</b>\n"
    "• Покупатель переводит деньги на счёт эскроу\n"
    "• Средства заморожены до получения товара\n"
    "• Продавец получает оплату только после вашего подтверждения\n"
    "\n"
    "✨ <b>Преимущества:</b>\n"
    "✓ Комиссия всего 1%\n"
    "✓ Поддержка валют: RUB, USD, EUR, KZT, BYN, UAH\n"
    "✓ Мгновенные переводы через СБП, карты и TON\n"
    "✓ Круглосуточная поддержка 24/7\n"
    "\n"
    f'💎 Менеджер: <a href="{MANAGER_URL}">@{MANAGER_NAME}</a>\n'
    "\n"
    "❤️ Приятных и безопасных сделок! ❞"
)

MEDIA_DIR = Path(__file__).resolve().parent / "media"
WELCOME_VIDEO = "welcome_video.mp4"

SAFETY_TEXT = (
    "🛡 <b>Безопасность сделки</b>\n\n"
    "• Средства перечисляются на счёт FunPay и замораживаются в эскроу.\n"
    "• Продавец получает деньги только после твоего подтверждения получения.\n"
    "• Никогда не отправляй товар до появления сделки в этом приложении.\n"
    "• Все действия фиксируются в истории сделки."
)


def app_keyboard() -> InlineKeyboardMarkup:
    """Кнопка приложения. Никогда не бросает исключение.

    Раньше здесь был RuntimeError при пустом WEBAPP_URL, из-за чего
    /start падал и пользователь не получал ответа вообще.
    """
    url = config.webapp_url
    if url:
        return InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(
                        text="Открыть приложение", web_app=WebAppInfo(url=url)
                    )
                ]
            ]
        )

    log.warning("WEBAPP_URL не задан — отправляю ссылку на бота вместо Mini App")
    if config.bot_link:
        return InlineKeyboardMarkup(
            inline_keyboard=[
                [InlineKeyboardButton(text="Открыть бота", url=config.bot_link)]
            ]
        )
    return InlineKeyboardMarkup(inline_keyboard=[])


def manager_url() -> str | None:
    return config.manager_link


@router.message(CommandStart())
async def cmd_start(message: Message, command: CommandObject) -> None:
    # /start <КОД> — открытие сделки по ссылке из «Поделиться сделкой»
    payload = (command.args or "").strip().upper()
    if payload:
        reply = await deal_card_text(payload)
        if reply:
            await message.answer(
                reply, parse_mode="HTML", reply_markup=deal_keyboard(payload)
            )
            return

    if not await send_welcome_video(message):
        # видео не отправилось — приветствие отдельным сообщением
        await message.answer(WELCOME, parse_mode="HTML", reply_markup=app_keyboard())


async def send_welcome_video(message: Message) -> bool:
    """Приветственное видео с текстом в подписи и кнопкой приложения.

    Одно сообщение вместо двух: текст идёт caption, кнопка крепится к видео.
    """
    video = MEDIA_DIR / WELCOME_VIDEO
    if not video.exists():
        log.warning("Приветственное видео не найдено: %s", video)
        return False

    # Лимит подписи к видео в Bot API — 1024 символа
    if len(WELCOME) > 1024:
        await message.answer_video(FSInputFile(video), reply_markup=app_keyboard())
        await message.answer(WELCOME, parse_mode="HTML", reply_markup=app_keyboard())
        return True

    try:
        await message.answer_video(
            FSInputFile(video),
            caption=WELCOME,
            parse_mode="HTML",
            reply_markup=app_keyboard(),
        )
        return True
    except TelegramBadRequest as exc:
        # Чаще всего — файл больше лимита Bot API (50 МБ)
        log.error("Не удалось отправить видео: %s", exc)
        return False


def deal_keyboard(code: str) -> InlineKeyboardMarkup:
    """Кнопка, открывающая Mini App сразу на этой сделке."""
    if not config.webapp_url:
        return app_keyboard()
    url = f"{config.webapp_url.rstrip('/')}/?deal={code}"
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Открыть приложение", web_app=WebAppInfo(url=url))]
        ]
    )


async def deal_card_text(code: str) -> str | None:
    """Карточка сделки для перехода по ссылке.

    Формат как в пересылке:
        https://t.me/<bot>?start=<код>
        FunPay — сделка #MV03P7QB
        123213.00 RUB
        ВЫФЫ
    """
    from . import db as D
    from .db import db as database

    row = await database.get_deal_by_code(code)
    if row is None:
        return None

    deal = D.row_to_deal(row)
    title = escape(deal["title"])
    if len(title) > 60:
        title = title[:57] + "…"

    lines = [f"<b>{deal['amount']:.2f} {deal['currency']}</b>", title]

    if config.webapp_url:
        # #КОД как кликабельный хештег: ведёт сразу на сделку в приложении
        deep = f"{config.webapp_url.rstrip('/')}/?deal={deal['code']}"
        lines.insert(0, f'Сделка FunPay #<a href="{deep}">{deal["code"]}</a>')
    else:
        lines.insert(0, f"Сделка FunPay #{deal['code']}")

    if config.bot_link:
        # ссылка первой строкой: при пересылке получатель сразу видит и ссылку
        lines.insert(0, f"{config.bot_link}?start={deal['code']}")
    return "\n".join(lines)


@router.message(Command("app", "sdelki", "сделки"))
async def cmd_app(message: Message) -> None:
    await message.answer("Открывай приложение:", reply_markup=app_keyboard())


@router.message(Command("help", "помощь"))
async def cmd_help(message: Message) -> None:
    await message.answer(
        "📖 <b>Команды</b>\n\n"
        "/start — описание сервиса\n"
        "/app — открыть приложение\n"
        "/manager — написать менеджеру\n"
        "/safety — правила безопасной сделки\n"
        "/luxenaction — служебная команда",
        parse_mode="HTML",
    )


@router.message(Command("manager", "менеджер"))
async def cmd_manager(message: Message) -> None:
    url = manager_url()
    if not url:
        await message.answer("Менеджер пока не назначен. Аккаунт будет указан позже.")
        return
    await message.answer(f"💬 Написать менеджеру: {url}")


@router.message(Command("safety", "безопасность"))
async def cmd_safety(message: Message) -> None:
    await message.answer(SAFETY_TEXT, parse_mode="HTML")


@router.message(Command("luxenaction"))
async def cmd_luxenaction(message: Message, command: CommandObject) -> None:
    """Служебная команда. Логика будет добавлена по ТЗ владельца."""
    args = (command.args or "").strip()
    log.info("luxenaction от %s, args=%r", message.from_user.id, args)
    await message.answer(
        "Команда /luxenaction принята. Функционал в разработке — "
        "опиши, что она должна делать, и я добавлю."
    )


@router.message(F.text)
async def fallback(message: Message) -> None:
    await message.answer(
        "Открой приложение, чтобы создать сделку:", reply_markup=app_keyboard()
    )


async def check_webapp_url() -> None:
    """Проверяет, что адрес Mini App отдаёт приложение.

    Без проверки кнопка меню и ссылки на сделку выглядят рабочими,
    но ведут в заглушку туннеля или на мёртвый адрес.
    """
    url = config.webapp_url
    if not url:
        log.error("WEBAPP_URL пуст: кнопка меню и ссылки на сделку работать не будут")
        return
    if "example.com" in url:
        log.error("WEBAPP_URL — заглушка (%s). Нужен реальный HTTPS-адрес", url)
        return

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                url, timeout=aiohttp.ClientTimeout(total=15)
            ) as resp:
                status = resp.status
                body = await resp.text()
    except Exception as exc:  # noqa: BLE001
        log.error("WEBAPP_URL недоступен (%s): %s", url, exc)
        return

    if status != 200 or "FunPay Deal" not in body:
        log.error(
            "По адресу %s отдаётся не приложение (HTTP %s) — "
            "похоже на страницу-заглушку туннеля",
            url,
            status,
        )
    else:
        log.info("Mini App по адресу %s отдаётся корректно", url)


async def setup_commands(bot: Bot) -> None:
    await bot.set_my_commands(
        [
            BotCommand(command="start", description="Описание сервиса"),
            BotCommand(command="app", description="Открыть приложение"),
            BotCommand(command="manager", description="Написать менеджеру"),
            BotCommand(command="safety", description="Безопасность сделки"),
            BotCommand(command="luxenaction", description="Служебная команда"),
        ]
    )
    if config.webapp_url:
        await bot.set_chat_menu_button(
            menu_button=MenuButtonWebApp(
                text="FunPay Deal", web_app=WebAppInfo(url=config.webapp_url)
            )
        )