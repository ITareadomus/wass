-- phpMyAdmin SQL Dump
-- version 5.2.2
-- https://www.phpmyadmin.net/
--
-- Host: 139.59.132.41
-- Creato il: Gen 27, 2026 alle 09:38
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
-- Database: `adamdb`
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
  `reference_id` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT '',
  `structure_id` int UNSIGNED NOT NULL,
  `operation_id` int UNSIGNED DEFAULT '0',
  `activity_id` int UNSIGNED DEFAULT '0',
  `checkout` date DEFAULT NULL,
  `checkout_time` varchar(5) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `checkout_pax` int UNSIGNED NOT NULL DEFAULT '0',
  `checkin` date DEFAULT NULL,
  `checkin_time` varchar(5) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `checkin_pax` int UNSIGNED NOT NULL DEFAULT '0',
  `notes` text COLLATE utf8mb4_unicode_ci,
  `notes_read` tinyint DEFAULT '0',
  `category` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT '',
  `no_show` tinyint NOT NULL DEFAULT '0',
  `pax_setup` int UNSIGNED NOT NULL DEFAULT '0',
  `cleaned_at` datetime DEFAULT NULL,
  `cleaned_by` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT '0',
  `created_at_client` datetime DEFAULT NULL,
  `created_at_milliseconds` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT '0',
  `updated_at_client` datetime DEFAULT NULL,
  `updated_at_milliseconds` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT '0',
  `deleted_at_client` datetime DEFAULT NULL,
  `deleted_at_milliseconds` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT '0',
  `assigned_at_us` datetime DEFAULT NULL,
  `assigned_at_milliseconds` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT '0',
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
  `extratimes` text COLLATE utf8mb4_unicode_ci,
  `survey` tinyint DEFAULT '0',
  `survey_by` varchar(11) COLLATE utf8mb4_unicode_ci DEFAULT '',
  `survey_at` datetime DEFAULT NULL,
  `equipments` text COLLATE utf8mb4_unicode_ci,
  `equipments_notes` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `logistic_notes` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `logistic_label_printed` tinyint DEFAULT '0',
  `optimoroute_delivery_id` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `optimoroute_delivery_code` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `optimoroute_delivery_message` varchar(400) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_by` varchar(11) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `updated_by` varchar(11) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `deleted_by` varchar(11) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL,
  `deleted_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dump dei dati per la tabella `app_housekeeping`
--

INSERT INTO `app_housekeeping` (`id`, `version`, `migration_id`, `program_id`, `reference_id`, `structure_id`, `operation_id`, `activity_id`, `checkout`, `checkout_time`, `checkout_pax`, `checkin`, `checkin_time`, `checkin_pax`, `notes`, `notes_read`, `category`, `no_show`, `pax_setup`, `cleaned_at`, `cleaned_by`, `created_at_client`, `created_at_milliseconds`, `updated_at_client`, `updated_at_milliseconds`, `deleted_at_client`, `deleted_at_milliseconds`, `assigned_at_us`, `assigned_at_milliseconds`, `cleaned_by_us`, `collaboration`, `collaboration_by`, `collaboration_at`, `collaboration_bypass`, `helpwork`, `helpwork_by`, `helpwork_at`, `startwork`, `startwork_at`, `startreport`, `startreport_at`, `cleaned`, `closed`, `deleted`, `is_internal`, `sequence`, `extratimes`, `survey`, `survey_by`, `survey_at`, `equipments`, `equipments_notes`, `logistic_notes`, `logistic_label_printed`, `optimoroute_delivery_id`, `optimoroute_delivery_code`, `optimoroute_delivery_message`, `created_by`, `updated_by`, `deleted_by`, `created_at`, `updated_at`, `deleted_at`) VALUES
(194964, 1, 87534, 0, '571800', 1674, 3, 0, '2026-01-01', '', 2, NULL, '', 0, 'Pulizie di uscita soggiorno long stay', 0, 'DEEP', 0, 0, NULL, '', '2024-12-13 14:32:33', '20241213143232977000', '2024-12-13 14:32:33', '20241213143232977000', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 0, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 1, '817566a1b1a733cbd41adada0868529d', NULL, NULL, 'M2', 'E66', '', '2024-12-13 15:00:43', '2026-01-01 08:00:26', NULL),
(198682, 1, 90150, 0, '596716', 105, 3, 0, '2026-01-01', '', 2, NULL, '', 0, 'Pulizie di uscita soggiorno long stay', 0, 'DEEP', 0, 0, NULL, '', '2025-02-07 11:39:37', '20250207113937445000', '2025-02-07 11:39:37', '20250207113937445000', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 0, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 1, '332038401538bf7b29ffad02ffdbe972', NULL, NULL, 'M2', 'E66', '', '2025-02-07 12:00:34', '2026-01-01 08:00:26', NULL),
(219714, 1, 0, 0, '0', 2294, 2, 1, '2026-01-01', '11:00', 0, '2026-01-01', '14:00', 3, '', 0, 'CUSTOMER_PROGRAM', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:08', '20260102113808256000', 845, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 1, '', 0, '', NULL, NULL, NULL, NULL, 1, 'd1336068bb0bc0aa3b391c57f021bf87', NULL, NULL, 'C115', 'test', '', '2025-12-01 15:42:18', '2026-01-02 11:38:08', NULL),
(220196, 1, 0, 0, '0', 2445, 2, 1, '2026-01-01', '11:00', 2, '2026-01-01', '14:30', 2, '', 0, 'CUSTOMER_PROGRAM', 0, 2, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:03', '20260102113803198000', 495, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 4, '', 0, '', NULL, NULL, NULL, NULL, 1, '44265e21fbe6a08c8271810acc273b2a', NULL, NULL, 'C124', 'test', '', '2025-12-12 18:59:34', '2026-01-02 11:38:03', NULL),
(220198, 1, 0, 0, '0', 2422, 2, 1, '2026-01-01', '11:00', 2, '2026-01-01', '14:30', 2, '', 0, 'CUSTOMER_PROGRAM', 0, 2, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:37:56', '20260102113756579000', 132, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 5, '', 0, '', NULL, NULL, NULL, NULL, 1, 'e78b34cb9948ed47e8aaab16ec2dbc93', NULL, NULL, 'C124', 'test', '', '2025-12-12 19:01:23', '2026-01-02 11:37:56', NULL),
(220646, 1, 0, 0, '0', 2463, 2, 1, '2026-01-01', '11:00', 0, '2026-01-01', '15:00', 4, '', 0, 'CUSTOMER_PROGRAM', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:04', '20260102113804515000', 785, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 2, '', 0, '', NULL, NULL, NULL, NULL, 1, '41927a155818701276f802ab9a4cd27d', NULL, NULL, 'C131', 'test', '', '2025-12-24 09:13:47', '2026-01-02 11:38:04', NULL),
(220674, 1, 0, 0, '0', 2324, 2, 0, '2026-01-01', '11:00', 5, '2026-01-01', '15:00', 5, '', 0, 'CUSTOMER_PROGRAM', 0, 5, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:11', '20260102113811343000', 722, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 2, '', 0, '', NULL, NULL, NULL, NULL, 1, 'b394647b11a0c669fb23725af53184d0', NULL, NULL, 'C121', 'test', '', '2025-12-25 13:03:41', '2026-01-02 11:38:11', NULL),
(220704, 1, 0, 0, '0', 2231, 2, 1, '2026-01-01', '11:00', 0, '2026-01-01', '13:00', 2, '', 0, 'CUSTOMER_PROGRAM', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:37:57', '20260102113757458000', 771, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 2, '', 0, '', NULL, NULL, NULL, NULL, 1, 'd426cb1a8c1cb69e2b0dd9bbd113cd35', NULL, NULL, 'C115', 'test', '', '2025-12-26 12:07:49', '2026-01-02 11:37:57', NULL),
(220723, 1, 0, 0, '0', 2279, 2, 0, '2026-01-01', '10:15', 2, '2026-01-01', '15:00', 2, 'Check out Oscar Rabelo', 2, 'CUSTOMER_PROGRAM', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:00', '20260102113800097000', 404, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 1, '', 0, '', NULL, NULL, NULL, NULL, 1, '2613745674038e6a685f42e3a28bbe22', NULL, NULL, 'C118', 'test', '', '2025-12-26 16:52:22', '2026-01-02 11:38:00', NULL),
(220739, 1, 103603, 0, '31349', 2376, 2, 0, '2026-01-01', NULL, 1, '2026-01-02', '15:00', 2, 'PROSSIMA CONFIGURAZIONE:</br>Matrimoniale', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:37:54', '20260102113754817000', 771, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 1, '', 0, '', NULL, NULL, NULL, NULL, 1, 'b13d074eb990c486262d0ece8e829156', NULL, NULL, 'M61', 'test', '', '2025-12-27 13:30:19', '2026-01-02 11:37:54', NULL),
(220762, 1, 103639, 0, '30808', 1064, 2, 0, '2026-01-01', NULL, 2, '2026-01-03', NULL, 1, 'PROSSIMA CONFIGURAZIONE:</br>Matrimoniale', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:37:57', '20260102113757018000', 495, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 1, '', 0, '', NULL, NULL, NULL, NULL, 1, '592379ad2472f92711d87569e147cef2', NULL, NULL, 'M61', 'test', '', '2025-12-28 13:30:18', '2026-01-02 11:37:57', NULL),
(220763, 2, 103673, 0, '31357', 2374, 2, 0, '2026-01-01', NULL, 1, '2026-01-02', NULL, 2, 'PROSSIMA CONFIGURAZIONE:</br>Matrimoniale', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:02', '20260102113802757000', 495, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 2, '', 0, '', NULL, NULL, NULL, NULL, 1, '3c1e1be301c2cc9c2e28c74dc93b9c80', NULL, NULL, 'M61', 'test', '', '2025-12-28 13:30:19', '2026-01-02 11:38:02', NULL),
(220764, 1, 103641, 0, '36779', 2268, 2, 0, '2026-01-01', NULL, 1, '2026-01-01', NULL, 1, 'PROLUNGO NON COMUNICATO, ADDEBITARE TEMPO AUTISTA - AUTOTRIZZATO DAL CLIENTE', 0, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:01', '20260102113801424000', 737, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 4, '', 0, '', NULL, NULL, NULL, NULL, 1, '47e4389c07c5a6b8c8e2032530e6fa1b', 'ERR_ORD_MISSING', 'Order with specified orderNo does not exist in the system.', 'M94', 'test', '', '2025-12-28 13:30:19', '2026-01-02 11:38:01', NULL),
(220765, 2, 103673, 0, '30414', 1079, 2, 0, '2026-01-01', NULL, 2, '2026-01-08', NULL, 3, 'PROSSIMA CONFIGURAZIONE:</br>Matrimoniale + Divano Letto Singolo', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:37:58', '20260102113758340000', 132, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 1, '', 0, '', NULL, NULL, NULL, NULL, 1, '31100b7caa6154e218bdec86b04b9714', 'ERR_ORD_MISSING', 'Order with specified orderNo does not exist in the system.', 'M61', 'test', '', '2025-12-28 13:30:20', '2026-01-02 11:37:58', NULL),
(220766, 3, 103738, 0, '42234', 2222, 2, 0, '2026-01-01', NULL, 5, '2026-01-02', '15:00', 4, 'NOTE:</br>Ospiti hanno late check-out, escono alle 12:00</br>PROSSIMA CONFIGURAZIONE:</br>Matrimoniale + divano letto', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:08', '20260102113808695000', 789, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 2, '', 0, '', NULL, NULL, NULL, NULL, 1, 'bd4eb06b84a981668884171464c58f5a', NULL, NULL, 'M94', 'test', '', '2025-12-28 13:30:20', '2026-01-02 11:38:08', NULL),
(220767, 4, 103751, 0, '31544', 1983, 2, 0, '2026-01-01', NULL, 1, '2026-01-02', '13:30', 1, 'PROSSIMA CONFIGURAZIONE:</br>Singola', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:04', '20260102113804075000', 1060, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 1, '', 0, '', NULL, NULL, NULL, NULL, 1, 'cf84439594ff13a4f2bbc25c068d3c74', NULL, NULL, 'M61', 'test', '', '2025-12-28 13:30:20', '2026-01-02 11:38:04', NULL),
(220770, 2, 103654, 0, '39326', 2450, 2, 0, '2026-01-01', NULL, 4, '2026-01-12', '19:00', 1, '', 0, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:05', '20260102113805396000', 326, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 4, '', 0, '', NULL, NULL, NULL, NULL, 1, '9e9eb92aa2d53c3351c7920defccb212', NULL, NULL, 'M123', 'test', '', '2025-12-28 13:30:21', '2026-01-02 11:38:05', NULL),
(220773, 1, 103641, 0, '40343', 2372, 2, 0, '2026-01-01', NULL, 3, '2026-01-14', NULL, 3, 'PROSSIMA CONFIGURAZIONE:</br>Matrimoniale + divano letto', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:00', '20260102113800984000', 771, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 3, '', 0, '', NULL, NULL, NULL, NULL, 1, 'e50dca65d877122e2092d6bd6ca55503', NULL, NULL, 'M94', 'test', '', '2025-12-28 13:30:21', '2026-01-02 11:38:00', NULL),
(220775, 1, 103643, 0, '40295', 2449, 2, 0, '2026-01-01', NULL, 1, '2026-01-15', '20:00', 2, '', 0, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:11', '20260102113811794000', 469, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 3, '', 0, '', NULL, NULL, NULL, NULL, 1, '3c1624dc5d8f42b6ef3eae6bcd595912', NULL, NULL, 'M123', 'test', '', '2025-12-28 13:30:21', '2026-01-02 11:38:11', NULL),
(220777, 2, 103682, 0, '39138', 2415, 2, 0, '2026-01-01', NULL, 1, '2026-01-01', '15:00', 4, '', 0, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:04', '20260102113804955000', 326, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 3, '', 0, '', NULL, NULL, NULL, NULL, 1, '4e968946a84472d56920886774618795', NULL, NULL, 'M123', 'test', '', '2025-12-28 13:30:21', '2026-01-02 11:38:04', NULL),
(220780, 1, 103639, 0, '31362', 2378, 2, 0, '2026-01-01', NULL, 2, '2026-01-12', '16:30', 1, 'PROSSIMA CONFIGURAZIONE:</br>Divano letto', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:05', '20260102113805835000', 249, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 1, '', 0, '', NULL, NULL, NULL, NULL, 1, '21bef39f778cc5fdd571667112b271d9', NULL, NULL, 'M61', 'test', '', '2025-12-28 13:30:22', '2026-01-02 11:38:05', NULL),
(220782, 1, 103643, 0, '39259', 2469, 2, 0, '2026-01-01', '', 3, '2026-01-15', '15:00', 3, '', 0, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2025-12-31 23:14:00', '20251231231400456065', 249, 0, 0, NULL, 0, 0, 0, NULL, 1, '2026-01-01 17:00:59', 1, '2026-01-01 22:09:47', 1, 0, 0, 0, 3, NULL, 0, '', NULL, NULL, NULL, NULL, 1, 'eeadc9991c37fca689dda9b92c4eb401', NULL, NULL, 'M123', 'U249', '', '2025-12-28 13:30:22', '2026-01-01 22:10:45', NULL),
(220783, 1, 103643, 0, '40252', 2389, 2, 0, '2026-01-01', NULL, 2, '2026-01-01', '15:00', 4, '', 0, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:37:58', '20260102113758780000', 789, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 2, '', 0, '', NULL, NULL, NULL, NULL, 1, '299817b2b2e4cc91bcc010dc5e479dab', NULL, NULL, 'M123', 'test', '', '2025-12-28 13:30:23', '2026-01-02 11:37:58', NULL),
(220784, 2, 103707, 0, '40297', 2461, 2, 0, '2026-01-01', NULL, 1, '2026-01-01', NULL, 2, '', 0, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:12', '20260102113812235000', 326, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 4, '', 0, '', NULL, NULL, NULL, NULL, 1, 'ba8af094afa20dc0428390e3a46e5277', NULL, NULL, 'M123', 'test', '', '2025-12-28 13:30:23', '2026-01-02 11:38:12', NULL),
(220785, 1, 103639, 0, '31586', 2382, 2, 0, '2026-01-01', NULL, 1, '2026-01-08', NULL, 1, 'PROSSIMA CONFIGURAZIONE:</br>Letto alla francese', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:07', '20260102113807155000', 404, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 2, '', 0, '', NULL, NULL, NULL, NULL, 1, 'beb48f7d68266f3ac9145ce597b6a9b6', NULL, NULL, 'M61', 'test', '', '2025-12-28 13:30:23', '2026-01-02 11:38:07', NULL),
(220786, 2, 103713, 0, '40166', 2482, 2, 0, '2026-01-01', NULL, 2, '2026-01-01', NULL, 1, '', 0, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:03', '20260102113803637000', 845, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 6, '', 0, '', NULL, NULL, NULL, NULL, 1, '13572bdd07afa23f4b76639e2336ba7b', NULL, NULL, 'M123', 'test', '', '2025-12-28 13:30:23', '2026-01-02 11:38:03', NULL),
(220792, 1, 103650, 0, '51217210', 1502, 2, 1, '2026-01-01', '11:00', 4, '2026-01-01', '14:00', 4, '', 0, '', 0, 0, NULL, '', '2025-12-12 21:31:49', '20251212213149000000', '2025-12-28 12:58:12', '20251228125812000000', NULL, '0', '2026-01-02 11:38:10', '20260102113810895000', 845, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 1, '', 0, '', NULL, NULL, NULL, NULL, 1, '748378ef8b73c9af3e9b1919610994c6', NULL, NULL, 'M64', 'test', '', '2025-12-28 16:55:08', '2026-01-02 11:38:10', NULL),
(220883, 2, 103744, 0, '31661', 1793, 2, 0, '2026-01-01', NULL, 2, '2026-01-02', '15:00', 2, 'PROSSIMA CONFIGURAZIONE:</br>Matrimoniale', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:09', '20260102113809793000', 1060, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 3, '', 0, '', NULL, NULL, NULL, NULL, 1, 'a25113b16898daf00f3e8b0473e3c87e', NULL, NULL, 'M61', 'test', '', '2025-12-30 17:02:16', '2026-01-02 11:38:09', NULL),
(220884, 1, 0, 0, '0', 2464, 2, 1, '2026-01-01', '11:00', 0, '2026-01-01', '15:00', 4, '', 0, 'CUSTOMER_PROGRAM', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:10', '20260102113810016000', 785, 0, 0, NULL, 0, 0, 0, NULL, 1, '2026-01-01 11:00:00', 1, '2026-01-01 13:00:00', 1, 0, 0, 0, 4, '', 0, '', NULL, NULL, NULL, NULL, 1, '1dab1312d12e980975c3ca4aaaed5145', NULL, NULL, 'C131', 'test', '', '2025-12-30 17:02:25', '2026-01-02 11:38:10', NULL),
(220893, 2, 103743, 0, '44786', 2321, 2, 0, '2026-01-01', NULL, 1, '2026-07-05', NULL, 2, 'NOTE:</br>fare ultima pulizie senza allestimento, riconsegniamo la casa</br>PROSSIMA CONFIGURAZIONE:</br>Matrimoniale', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:09', '20260102113809133000', 404, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 3, '', 0, '', NULL, NULL, NULL, NULL, 1, 'bd6010b2b8dd003a052725d7a122027c', NULL, NULL, 'M94', 'test', '', '2025-12-31 08:55:09', '2026-01-02 11:38:09', NULL),
(220896, 1, 0, 0, '0', 1072, 2, 0, '2026-01-01', '11:30', 0, '2026-01-01', '12:00', 2, NULL, 0, 'CUSTOMER_PROGRAM', 0, 2, NULL, NULL, NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:37:55', '20260102113755698000', 132, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 3, '', 0, '', NULL, NULL, NULL, NULL, 1, 'd4b598d5c2d06190d7880ea25737ec8d', NULL, NULL, 'C67', 'test', '', '2025-12-31 10:56:20', '2026-01-02 11:37:55', NULL),
(220897, 1, 0, 0, '0', 1073, 2, 0, '2026-01-01', '11:30', 0, '2026-01-01', '12:00', 2, NULL, 0, 'CUSTOMER_PROGRAM', 0, 2, NULL, NULL, NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:37:55', '20260102113755257000', 132, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 2, '', 0, '', NULL, NULL, NULL, NULL, 1, '3a049a71f5ec7eac96cce353288bb7c9', NULL, NULL, 'C67', 'test', '', '2025-12-31 10:56:46', '2026-01-02 11:37:55', NULL),
(220898, 1, 0, 0, '0', 1074, 2, 0, '2026-01-01', '11:30', 0, '2026-01-01', NULL, 2, '', 0, 'CUSTOMER_PROGRAM', 0, 2, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:37:56', '20260102113756139000', 132, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 4, '', 0, '', NULL, NULL, NULL, NULL, 1, '7cd3f501ead08f816f7bd70158a74f8f', NULL, NULL, 'C67', 'test', '', '2025-12-31 10:57:14', '2026-01-02 11:37:56', NULL),
(220903, 1, 103747, 0, '23083', 449, 2, 0, '2026-01-01', NULL, 5, '2026-01-01', '15:00', 3, 'PROSSIMA CONFIGURAZIONE:</br>1 Matrimoniale + 1 Singolo', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:00', '20260102113800543000', 785, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 2, '', 0, '', NULL, NULL, NULL, NULL, 1, 'ac3dda1b78282febaee6c92c269ce487', NULL, NULL, 'M3', 'test', '', '2025-12-31 13:30:21', '2026-01-02 11:38:00', NULL),
(220906, 1, 103747, 0, '23084', 946, 2, 0, '2026-01-01', NULL, 4, '2026-01-01', '15:00', 2, 'PROSSIMA CONFIGURAZIONE:</br>2 Matrimoniali', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:06', '20260102113806274000', 722, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 2, '', 0, '', NULL, NULL, NULL, NULL, 1, 'df62b060acdfeae3ce72eeb54a7baf9f', NULL, NULL, 'M3', 'test', '', '2025-12-31 13:30:22', '2026-01-02 11:38:06', NULL),
(220907, 1, 103747, 0, '23086', 1238, 2, 0, '2026-01-01', NULL, 4, '2026-01-01', '13:00', 4, 'PROSSIMA CONFIGURAZIONE:</br>1 Matrimoniale + 1 Divano Letto', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:07', '20260102113807375000', 249, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 3, '', 0, '', NULL, NULL, NULL, NULL, 1, 'efe567f5ef8ccb423f3e324a2569f6ed', NULL, NULL, 'M3', 'test', '', '2025-12-31 13:30:22', '2026-01-02 11:38:07', NULL),
(220908, 2, 103763, 0, '23087', 1714, 2, 0, '2026-01-01', '', 2, '2026-01-02', '15:00', 2, 'PROSSIMA CONFIGURAZIONE:</br>1 Divano Letto', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-01 14:34:47', '20260101143447522336', 1031, 0, 0, NULL, 0, 0, 0, NULL, 1, '2026-01-01 16:02:09', 1, '2026-01-01 18:20:39', 1, 0, 0, 0, 2, '', 0, '', NULL, NULL, NULL, NULL, 1, '07f7b2645111d973a2a45f654ad6f657', NULL, NULL, 'M3', 'U1031', '', '2025-12-31 13:30:22', '2026-01-01 18:21:23', NULL),
(220911, 1, 103747, 0, '23089', 2218, 2, 0, '2026-01-01', NULL, 4, '2026-01-01', '15:00', 4, 'PROSSIMA CONFIGURAZIONE:</br>1 Matrimoniale + 1 Divano Letto', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:07', '20260102113807815000', 1060, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 5, '', 0, '', NULL, NULL, NULL, NULL, 1, '385acc96129257652115e338b0603e4f', NULL, NULL, 'M3', 'test', '', '2025-12-31 13:30:23', '2026-01-02 11:38:07', NULL),
(220912, 1, 103747, 0, '23090', 2210, 2, 0, '2026-01-01', NULL, 5, '2026-01-01', '19:30', 6, 'TEMPO EXTRA AUTORIZZATO DAL CLIENTE. 30 MINUTI PER ATTESA USCITA OSPITI - 30 MINUTI PER PULIZIA', 2, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:06', '20260102113806715000', 1031, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 3, '', 0, '', NULL, NULL, NULL, NULL, 1, 'a1add65ca523a72561a7ba5d3457deb7', NULL, NULL, 'M3', 'test', '', '2025-12-31 13:30:23', '2026-01-02 11:38:06', NULL),
(220913, 1, 103747, 0, '23091', 2276, 2, 0, '2026-01-01', NULL, 2, '2026-01-02', '15:00', 2, 'PROSSIMA CONFIGURAZIONE:</br>Matrimoniale', 3, 'cleaning', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:37:59', '20260102113759220000', 469, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 3, '', 0, '', NULL, NULL, NULL, NULL, 1, '8c3a4816da1b61dd9fbcedb58f71bb9d', NULL, NULL, 'M3', 'test', '', '2025-12-31 13:30:23', '2026-01-02 11:37:59', NULL),
(220922, 1, 0, 0, '0', 2478, 2, 1, '2026-01-01', '11:15', 0, '2026-01-01', '14:00', 1, 'METTERE CAFFE (ARMADIETTO DIPENDENTI CODICE 999)', 1, 'CUSTOMER_PROGRAM', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:01', '20260102113801865000', 469, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 1, '', 0, '', NULL, NULL, NULL, NULL, 1, '0c772b5987ffdaefbeb490f706eb73d4', NULL, NULL, 'C132', 'test', '', '2025-12-31 15:42:50', '2026-01-02 11:38:01', NULL),
(220923, 1, 0, 0, '0', 2480, 2, 1, '2026-01-01', '11:15', 0, '2026-01-01', '14:00', 3, 'ADDEBITARE SOLO 30 MINUTI AL CLIENTE \r\nAPRIRE DIVANO LETTO + METTERE CAFFE (ARMADIETTO DIPENDENTI CODICE 999) /// LASCIARE I NOSTRI ASCIUGAMANI BIANCHI RIGATI /// gli ospiti in checkin lasciano bagagli alle 13, e tornano alle 14', 2, 'CUSTOMER_PROGRAM', 0, 0, NULL, NULL, NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:38:02', '20260102113802316000', 789, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 0, 2, '', 0, '', NULL, NULL, NULL, NULL, 1, '2249a32ed49402bf49325c97024d2a01', NULL, NULL, 'C132', 'test', '', '2025-12-31 15:46:04', '2026-01-02 11:38:02', NULL),
(220929, 1, 0, 0, '0', 2458, 2, 0, '2026-01-01', NULL, 0, '2026-01-01', NULL, 0, NULL, 0, NULL, 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', '2026-01-02 11:37:59', '20260102113759659000', 845, 0, 0, NULL, 0, 0, 0, NULL, 0, NULL, 0, NULL, 1, 0, 0, 1, 4, '', 0, '', NULL, NULL, NULL, NULL, 1, '3de41de2012d8d9cfb99ab43e4fdee0f', NULL, NULL, 'E4', 'test', '', '2025-12-31 21:32:50', '2026-01-02 11:37:59', NULL),
(220930, 1, 0, 0, '0', 2458, 2, 1, '2026-01-01', '11:00', 0, '2026-01-01', '', 0, '1 mat 2 pax', 0, 'CUSTOMER_PROGRAM', 0, 0, NULL, '', NULL, '0', NULL, '0', NULL, '0', NULL, '0', 0, 0, NULL, NULL, 0, 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, 0, 0, 0, NULL, 0, '', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'C3', 'C3', '', '2026-01-01 09:31:22', '2026-01-01 09:31:22', NULL);

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
  MODIFY `id` int UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=221980;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
