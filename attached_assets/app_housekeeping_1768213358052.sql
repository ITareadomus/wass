-- phpMyAdmin SQL Dump
-- version 5.2.2
-- https://www.phpmyadmin.net/
--
-- Host: 139.59.132.41
-- Creato il: Gen 12, 2026 alle 10:21
-- Versione del server: 8.0.42-0ubuntu0.20.04.1
-- Versione PHP: 7.4.3-4ubuntu2.29

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `wass_sviluppo`
--

-- --------------------------------------------------------

--
-- Struttura della tabella `app_housekeeping`
--

CREATE TABLE `app_housekeeping` (
  `id` int UNSIGNED NOT NULL,
  `version` int UNSIGNED DEFAULT '1',
  `migration_id` int UNSIGNED DEFAULT '0',
  `program_id` int UNSIGNED DEFAULT '0',
  `reference_id` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `structure_id` int UNSIGNED NOT NULL,
  `operation_id` int UNSIGNED DEFAULT '0',
  `activity_id` int UNSIGNED DEFAULT '0',
  `checkout` date DEFAULT NULL,
  `checkout_time` varchar(5) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `checkout_pax` int UNSIGNED NOT NULL DEFAULT '0',
  `checkin` date DEFAULT NULL,
  `checkin_time` varchar(5) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `checkin_pax` int UNSIGNED NOT NULL DEFAULT '0',
  `notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `notes_read` tinyint DEFAULT '0',
  `category` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `no_show` tinyint NOT NULL DEFAULT '0',
  `pax_setup` int UNSIGNED NOT NULL DEFAULT '0',
  `cleaned_at` datetime DEFAULT NULL,
  `cleaned_by` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '0',
  `created_at_client` datetime DEFAULT NULL,
  `created_at_milliseconds` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '0',
  `updated_at_client` datetime DEFAULT NULL,
  `updated_at_milliseconds` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '0',
  `deleted_at_client` datetime DEFAULT NULL,
  `deleted_at_milliseconds` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '0',
  `assigned_at_us` datetime DEFAULT NULL,
  `assigned_at_milliseconds` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '0',
  `cleaned_by_us` int UNSIGNED DEFAULT '0',
  `collaboration` tinyint UNSIGNED DEFAULT '0',
  `collaboration_by` int DEFAULT NULL,
  `collaboration_at` timestamp NULL DEFAULT NULL,
  `collaboration_bypass` tinyint UNSIGNED DEFAULT '0',
  `helpwork` tinyint UNSIGNED DEFAULT '0',
  `helpwork_by` int DEFAULT NULL,
  `helpwork_at` timestamp NULL DEFAULT NULL,
  `startwork` tinyint DEFAULT '0',
  `startwork_at` datetime DEFAULT NULL,
  `startreport` tinyint DEFAULT '0',
  `startreport_at` datetime DEFAULT NULL,
  `cleaned` tinyint DEFAULT '0',
  `closed` tinyint DEFAULT '0',
  `deleted` tinyint DEFAULT '0',
  `is_internal` tinyint DEFAULT '0',
  `sequence` int DEFAULT '0',
  `extratimes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `survey` tinyint DEFAULT '0',
  `survey_by` varchar(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `survey_at` datetime DEFAULT NULL,
  `equipments` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `equipments_notes` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `logistic_notes` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `logistic_label_printed` tinyint DEFAULT '0',
  `optimoroute_delivery_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `optimoroute_delivery_code` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `optimoroute_delivery_message` varchar(400) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_by` varchar(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `updated_by` varchar(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `deleted_by` varchar(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL,
  `deleted_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dump dei dati per la tabella `app_housekeeping`
--

INSERT INTO `app_housekeeping` (`id`, `version`, `migration_id`, `program_id`, `reference_id`, `structure_id`, `operation_id`, `activity_id`, `checkout`, `checkout_time`, `checkout_pax`, `checkin`, `checkin_time`, `checkin_pax`, `notes`, `notes_read`, `category`, `no_show`, `pax_setup`, `cleaned_at`, `cleaned_by`, `created_at_client`, `created_at_milliseconds`, `updated_at_client`, `updated_at_milliseconds`, `deleted_at_client`, `deleted_at_milliseconds`, `assigned_at_us`, `assigned_at_milliseconds`, `cleaned_by_us`, `collaboration`, `collaboration_by`, `collaboration_at`, `collaboration_bypass`, `helpwork`, `helpwork_by`, `helpwork_at`, `startwork`, `startwork_at`, `startreport`, `startreport_at`, `cleaned`, `closed`, `deleted`, `is_internal`, `sequence`, `extratimes`, `survey`, `survey_by`, `survey_at`, `equipments`, `equipments_notes`, `logistic_notes`, `logistic_label_printed`, `optimoroute_delivery_id`, `optimoroute_delivery_code`, `optimoroute_delivery_message`, `created_by`, `updated_by`, `deleted_by`, `created_at`, `updated_at`, `deleted_at`) VALUES
(60478, 1, 0, 0, '0', 8, 2, 0, '2026-01-13', '', 0, '2026-01-13', '', 0, 'CAPITOLATO', 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2022-02-28 18:44:15', '20220228184415000000', 354, 0, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, 0, NULL, 0, 0, 0, 1, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'E26', 'E26', '', '2022-02-28 17:44:15', '2022-02-28 17:44:15', NULL),
(215294, 1, 0, 0, '0', 620, 2, 0, '2026-01-13', '', 0, NULL, '', 0, '', 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 1, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'E3', 'E3', '', '2025-09-23 15:16:36', '2025-09-23 15:16:36', NULL),
(215336, 1, 0, 0, '0', 621, 2, 0, '2026-01-13', '', 0, NULL, '', 0, '', 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 1, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'E3', 'E3', '', '2025-09-23 16:13:43', '2025-09-23 16:13:43', NULL),
(215419, 1, 0, 0, '0', 622, 2, 0, '2026-01-13', '', 0, NULL, '', 0, '', 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 1, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'E3', 'E3', '', '2025-09-23 16:19:16', '2025-09-23 16:19:16', NULL),
(215537, 1, 0, 0, '0', 672, 2, 0, '2026-01-13', '', 0, NULL, '', 0, '', 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 1, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'E3', 'E3', '', '2025-09-23 17:37:52', '2025-09-23 17:37:52', NULL),
(215647, 1, 0, 0, '0', 1030, 2, 0, '2026-01-13', '', 0, NULL, '', 0, '', 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 1, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'E3', 'E3', '', '2025-09-23 17:47:35', '2025-09-23 17:47:35', NULL),
(215770, 1, 0, 0, '0', 2114, 2, 0, '2026-01-13', '', 0, NULL, '', 0, '', 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 1, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'E3', 'E3', '', '2025-09-23 17:48:42', '2025-09-23 17:48:42', NULL),
(215893, 1, 0, 0, '0', 1963, 2, 0, '2026-01-13', '', 0, NULL, '', 0, '', 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 1, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'E3', 'E3', '', '2025-09-23 17:52:33', '2025-09-23 17:52:33', NULL),
(216016, 1, 0, 0, '0', 2065, 2, 0, '2026-01-13', '', 0, NULL, '', 0, '', 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 1, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'E3', 'E3', '', '2025-09-23 17:53:23', '2025-09-23 17:53:23', NULL),
(216546, 1, 0, 0, '0', 1002, 2, 0, '2026-01-13', '', 0, NULL, '', 0, '', 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 1, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'E3', 'E3', '', '2025-09-30 17:31:45', '2025-09-30 17:31:45', NULL),
(216669, 1, 0, 0, '0', 1002, 2, 0, '2026-01-13', '', 0, NULL, '', 0, '', 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 1, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'E3', 'E3', '', '2025-09-30 17:39:12', '2025-09-30 17:39:12', NULL),
(218502, 2, 101728, 0, '790110', 1084, 2, 0, '2026-01-13', '', 0, NULL, '', 0, 'Pulizie di uscita soggiorno long stay', 0, 'DEEP', 0, 0, NULL, '', '2025-11-05 13:52:36', '20251105135236092000', '2025-11-05 14:24:41', '20251105142441139000', '2025-11-05 14:24:41', '20251105142441138000', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 0, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, '7490bfba7703ea8bbc1a023244e45c75', NULL, NULL, 'M2', 'M2', '', '2025-11-05 15:00:30', '2025-11-05 15:30:20', NULL),
(220361, 1, 0, 0, '0', 2320, 2, 1, '2026-01-13', '11:00', 7, '2026-01-13', '', 7, '', 0, 'CUSTOMER_PROGRAM', 0, 7, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 0, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'C120', 'C120', '', '2025-12-16 13:38:15', '2025-12-16 13:38:15', NULL),
(220448, 1, 0, 0, '0', 278, 2, 0, '2026-01-13', '', 0, '2026-01-13', '', 0, 'DALLE 18 ALLE 22', 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2025-12-18 13:56:39', '20251218135639000000', 845, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 1, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'E3', 'E3', '', '2025-12-18 13:56:39', '2025-12-18 13:56:39', NULL),
(220604, 1, 0, 0, '0', 2427, 2, 0, '2026-01-13', '', 0, '2026-01-13', '', 0, '3 ore casa + 1 ora ufficio', 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2025-12-22 17:58:31', '20251222175831000000', 1064, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 1, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'E30', 'E30', '', '2025-12-22 17:58:31', '2025-12-22 17:58:31', NULL),
(220978, 1, 0, 0, '0', 2076, 2, 0, '2026-01-13', '11:00', 0, NULL, '', 0, '', 0, 'CUSTOMER_PROGRAM', 0, 1, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 0, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'C101', 'C101', '', '2026-01-02 13:20:39', '2026-01-02 13:20:39', NULL),
(221214, 1, 104023, 0, '31428', 1080, 2, 0, '2026-01-13', '', 2, '2026-01-16', '', 2, 'PROSSIMA CONFIGURAZIONE:</br>Matrimoniale', 0, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 0, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'M61', 'M61', '', '2026-01-09 13:30:20', '2026-01-09 13:30:20', NULL),
(221215, 2, 104051, 0, '29407', 763, 2, 0, '2026-01-13', '', 3, '2026-01-16', '15:00', 2, 'PROSSIMA CONFIGURAZIONE:</br>Matrimoniale', 0, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 0, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'M61', 'M61', '', '2026-01-09 13:30:20', '2026-01-10 13:30:19', NULL),
(221217, 3, 104079, 0, '31366', 1697, 2, 0, '2026-01-13', '', 2, '2026-01-13', '15:00', 1, 'PROSSIMA CONFIGURAZIONE:</br>Matrimoniale', 0, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 0, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'M61', 'M61', '', '2026-01-09 13:30:22', '2026-01-11 15:30:21', NULL),
(221220, 1, 104033, 0, '52132377', 1235, 2, 1, '2026-01-13', '11:00', 2, '2026-01-13', '14:00', 2, '', 0, '', 0, 0, NULL, '', '2026-01-05 10:17:10', '20260105101710000000', '2026-01-05 10:21:45', '20260105102145000000', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 0, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, '5326136b05eed860b21fa71f12c44538', NULL, NULL, 'M64', 'M64', '', '2026-01-09 16:55:09', '2026-01-09 16:55:09', NULL),
(221226, 1, 0, 0, '0', 2398, 2, 0, '2026-01-13', '', 0, '2026-01-13', '', 0, '', 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-09 18:43:55', '20260109184355000000', 845, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 1, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'E3', 'E3', '', '2026-01-09 18:43:55', '2026-01-09 18:43:55', NULL);

--
-- Indici per le tabelle scaricate
--

--
-- Indici per le tabelle `app_housekeeping`
--
ALTER TABLE `app_housekeeping`
  ADD PRIMARY KEY (`id`);

--
-- AUTO_INCREMENT per le tabelle scaricate
--

--
-- AUTO_INCREMENT per la tabella `app_housekeeping`
--
ALTER TABLE `app_housekeeping`
  MODIFY `id` int UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=221275;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
